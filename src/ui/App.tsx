/**
 * The interactive shell.
 *
 * Responsibilities:
 *   - own the transcript and render it
 *   - drive agent/loop.ts and translate its events into UI state
 *   - bridge the loop's async `confirm()` into a React prompt
 *   - handle slash commands
 *   - handle Ctrl-C: first press aborts the turn, second exits
 *
 * Completed transcript items render inside Ink's <Static>, which prints them
 * once and never re-renders them. That matters for both performance and
 * scrollback: without it, every token of a streaming response would repaint the
 * entire session history.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';

import { Conversation } from '../agent/messages.ts';
import { runTurn, type LoopEvent } from '../agent/loop.ts';
import { RunLedger, RetryBudget } from '../session/ledger.ts';
import { describeTermination, RunCancelledError } from '../agent/run.ts';
import { assessContext } from '../agent/truncate.ts';
import type { ProviderRegistry, ResolvedModel } from '../providers/registry.ts';
import { ConfigurationError } from '../providers/registry.ts';
import type { Config, TierName } from '../config/schema.ts';
import type { SessionStore } from '../session/store.ts';
import { addUsage, EMPTY_TOTALS, formatCost, type UsageTotals } from '../session/cost.ts';
import type { Tool, PermissionDecision, PermissionRequest, ToolDisplay } from '../tools/types.ts';
import type { ToolContext } from '../tools/types.ts';
import type { TodoStore, Todo } from '../tools/todo.ts';

import { Markdown } from './Markdown.tsx';
import { Confirm } from './Confirm.tsx';
import { CostView } from './CostView.tsx';
import { ErrorMessage, Notice, ToolCall, TodoList, UserMessage, Reasoning } from './components.tsx';
import { SPINNER_FRAMES, glyphs, theme } from './theme.ts';
import { HELP_TEXT, SLASH_COMMANDS } from './commands.ts';

export interface AppProps {
  config: Config;
  registry: ProviderRegistry;
  conversation: Conversation;
  model: ResolvedModel;
  tools: Map<string, Tool>;
  toolContext: ToolContext;
  store: SessionStore;
  sessionId: string;
  todoStore: TodoStore;
  startupWarnings: string[];
}

type Item =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | {
      id: number;
      kind: 'tool';
      name: string;
      summary: string;
      state: 'ok' | 'error';
      detail?: string;
      display?: ToolDisplay;
      durationMs: number;
    }
  | { id: number; kind: 'notice'; level: 'info' | 'warn'; text: string }
  | { id: number; kind: 'error'; message: string; hint?: string }
  | { id: number; kind: 'cost'; payload: React.ReactElement }
  | { id: number; kind: 'raw'; text: string };

/**
 * `Omit<Item, 'id'>` would collapse the union to its shared keys (`kind` only),
 * making every push() a type error. The conditional distributes over each
 * member first, so each variant keeps its own fields.
 */
type NewItem = Item extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [history, setHistory] = useState<Item[]>([]);
  const [streamText, setStreamText] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [running, setRunning] = useState<Array<{ id: string; name: string; summary: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [model, setModel] = useState<ResolvedModel>(props.model);
  const [totals, setTotals] = useState<UsageTotals>(() =>
    props.store.totalsForSession(props.sessionId),
  );
  const [todos, setTodos] = useState<Todo[]>(props.todoStore.get());
  const [spinner, setSpinner] = useState(0);
  const [interruptArmed, setInterruptArmed] = useState(false);

  const nextId = useRef(0);
  // Run ids are a storage primary key, so a same-millisecond collision would
  // silently overwrite the earlier run rather than record a second one.
  const nextRunSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const resolvePermission = useRef<((d: PermissionDecision) => void) | null>(null);
  const interruptTimer = useRef<NodeJS.Timeout | null>(null);

  const push = useCallback((item: NewItem): void => {
    setHistory((prev) => [...prev, { ...item, id: nextId.current++ } as Item]);
  }, []);

  // --- Startup ------------------------------------------------------------
  useEffect(() => {
    for (const warning of props.startupWarnings) {
      push({ kind: 'notice', level: 'warn', text: warning });
    }
    // Intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => props.todoStore.subscribe(setTodos), [props.todoStore]);

  // Spinner only ticks while busy — no timer churn at idle.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setSpinner((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [busy]);

  // --- Ctrl-C -------------------------------------------------------------
  useInput(
    (_input, key) => {
      if (!key.ctrl) return;
      if (_input === 'c') {
        if (busy) {
          // First priority is always stopping work in progress. The typed cause
          // keeps precedence right when Ctrl-C lands in the same tick as a tool
          // deadline — the loop reports the cancellation, not the tool.
          abortRef.current?.abort(new RunCancelledError('user'));
          return;
        }
        if (interruptArmed) {
          exit();
          return;
        }
        setInterruptArmed(true);
        if (interruptTimer.current) clearTimeout(interruptTimer.current);
        interruptTimer.current = setTimeout(() => setInterruptArmed(false), 2000);
      }
    },
    // Two guards: while a permission prompt is up Confirm owns the keyboard,
    // and without a TTY there is no raw mode for Ink to enter (it throws).
    { isActive: pending === null && Boolean(process.stdin.isTTY) },
  );

  // --- Permission bridge --------------------------------------------------
  const confirm = useCallback((request: PermissionRequest): Promise<PermissionDecision> => {
    return new Promise((resolve) => {
      resolvePermission.current = resolve;
      setPending(request);
    });
  }, []);

  const decide = useCallback((decision: PermissionDecision): void => {
    const resolve = resolvePermission.current;
    resolvePermission.current = null;
    setPending(null);
    resolve?.(decision);
  }, []);

  // --- Running a turn -----------------------------------------------------
  const runAgent = useCallback(
    async (text: string): Promise<void> => {
      setBusy(true);
      setStreamText('');
      setReasoning('');
      setRunning([]);

      const controller = new AbortController();
      abortRef.current = controller;

      const toolContext: ToolContext = { ...props.toolContext, signal: controller.signal };
      const accumulated: string[] = [];
      const toolMeta = new Map<string, { name: string; summary: string }>();

      // One ledger per submitted prompt, exactly as the desktop and headless
      // paths do. Without it the loop would still make its own — so the retry
      // ceiling would hold — but nothing would be finalized or persisted, and
      // the TUI would be the one front end whose runs left no record.
      const ledger = new RunLedger(
        `run_tui_${Date.now().toString(36)}_${nextRunSeq.current++}`,
        new RetryBudget(props.config.limits.maxRetries),
      );

      try {
        for await (const event of runTurn({
          conversation: props.conversation,
          model,
          tools: props.tools,
          toolContext,
          config: props.config,
          signal: controller.signal,
          ledger,
          confirm,
        })) {
          applyEvent(event);
        }
      } catch (err) {
        push({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Flush any streamed text that didn't get committed by a tool boundary.
        if (accumulated.length > 0) {
          push({ kind: 'assistant', text: accumulated.join('') });
          accumulated.length = 0;
        }
        setStreamText('');
        setReasoning('');
        setRunning([]);
        setBusy(false);
        abortRef.current = null;

        // Persistence is best-effort. If the process is already tearing down
        // (the database may be closed), losing the last save is far better than
        // an unhandled rejection over the top of the user's session.
        try {
          props.store.saveMessages(props.sessionId, props.conversation.messages);
          props.store.touch(props.sessionId, model.key);
          // Finalize first: it freezes the record, so whatever is written is
          // the same total the run would report if asked again.
          props.store.saveRunLedger(props.sessionId, ledger.finalize());
        } catch {
          /* ignore */
        }
      }

      function applyEvent(event: LoopEvent): void {
        switch (event.type) {
          case 'text_delta':
            accumulated.push(event.text);
            setStreamText((prev) => prev + event.text);
            break;

          case 'reasoning_delta':
            setReasoning((prev) => (prev + event.text).slice(-2000));
            break;

          case 'tool_start':
            // Commit streamed prose before the tool line so ordering in the
            // scrollback matches the order things actually happened.
            if (accumulated.length > 0) {
              push({ kind: 'assistant', text: accumulated.join('') });
              accumulated.length = 0;
              setStreamText('');
            }
            toolMeta.set(event.id, { name: event.name, summary: event.summary });
            setRunning((prev) => [...prev, { id: event.id, name: event.name, summary: event.summary }]);
            break;

          case 'tool_end': {
            setRunning((prev) => prev.filter((t) => t.id !== event.id));
            const meta = toolMeta.get(event.id);
            push({
              kind: 'tool',
              name: event.name,
              summary: meta?.summary ?? event.name,
              state: event.result.isError ? 'error' : 'ok',
              detail: event.result.isError ? event.result.content : undefined,
              display: event.result.display,
              durationMs: event.durationMs,
            });
            break;
          }

          case 'usage': {
            props.store.recordUsage(props.sessionId, event.usage, model.key, model.entry);
            setTotals((prev) => addUsage(prev, event.usage, model.entry));
            break;
          }

          case 'retry':
            push({
              kind: 'notice',
              level: 'warn',
              text: `Request failed (${event.message}) — retry ${event.attempt} in ${Math.round(event.delayMs / 1000)}s`,
            });
            break;

          case 'notice':
            push({ kind: 'notice', level: event.level, text: event.message });
            break;

          case 'error':
            push({ kind: 'error', message: event.message, hint: event.hint });
            break;

          case 'aborted':
            push({ kind: 'notice', level: 'warn', text: 'Interrupted.' });
            break;

          case 'done':
            // A `done` is not automatically a success — the step cap and a
            // truncated or refused response all arrive here. Say so, otherwise
            // the run just stops and looks finished.
            if (event.outcome !== 'completed') {
              push({
                kind: 'error',
                message: `Run ${event.outcome}: ${describeTermination(event.termination)}`,
              });
            }
            break;
        }
      }
    },
    [model, props, confirm, push],
  );

  // --- Submit -------------------------------------------------------------
  const submit = useCallback(
    async (raw: string): Promise<void> => {
      const text = raw.trim();
      if (!text || busy) return;
      setInput('');

      if (text.startsWith('/')) {
        handleSlash(text);
        return;
      }

      push({ kind: 'user', text });
      props.store.setTitleIfUnset(props.sessionId, text);
      props.conversation.addUserText(text);
      await runAgent(text);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, model, runAgent],
  );

  // --- Slash commands -----------------------------------------------------
  function handleSlash(text: string): void {
    const [command = '', ...rest] = text.slice(1).split(/\s+/);
    const argument = rest.join(' ').trim();

    switch (command.toLowerCase()) {
      case 'help':
        push({ kind: 'raw', text: HELP_TEXT });
        break;

      case 'model': {
        if (!argument) {
          push({
            kind: 'raw',
            text: [
              `Current: ${model.key}${model.tier ? ` (${model.tier} tier)` : ''}`,
              '',
              'Tiers:',
              `  fast    ${props.config.tiers.fast}`,
              `  cheap   ${props.config.tiers.cheap}`,
              `  strong  ${props.config.tiers.strong}`,
              '',
              'Switch with /model cheap | strong | fast, or /model <provider>/<id>.',
              `Known models: ${props.registry.listModels().join(', ')}`,
            ].join('\n'),
          });
          break;
        }
        try {
          const resolved = props.registry.resolve(argument);
          setModel(resolved);
          push({
            kind: 'notice',
            level: 'info',
            text: `Model set to ${resolved.key}. Prompt caches are per-model, so the next turn re-reads context at full price, then caches again.`,
          });
        } catch (err) {
          push({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
            hint: err instanceof ConfigurationError ? err.hint : undefined,
          });
        }
        break;
      }

      case 'cost': {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const usedSubscription = props.registry
          .listModels()
          .some((key) => key === model.key && model.entry.subscription);
        push({
          kind: 'cost',
          payload: (
            <CostView
              session={totals}
              today={props.store.totalsSince(startOfDay.getTime())}
              allTime={props.store.totalsAllTime()}
              byModel={props.store.totalsByModel(props.sessionId)}
              hasSubscriptionModel={usedSubscription}
            />
          ),
        });
        break;
      }

      case 'clear':
        props.conversation.setMessages([]);
        props.todoStore.clear();
        props.store.saveMessages(props.sessionId, []);
        setHistory([]);
        setTotals({ ...EMPTY_TOTALS });
        stdout?.write('\x1Bc');
        push({ kind: 'notice', level: 'info', text: 'Context cleared. Starting fresh.' });
        break;

      case 'tools':
        push({
          kind: 'raw',
          text: [...props.tools.values()]
            .map((t) => `  ${t.name.padEnd(14)} ${t.readOnly ? '(read-only) ' : ''}${firstSentence(t.description)}`)
            .sort()
            .join('\n'),
        });
        break;

      case 'permissions': {
        if (argument && ['safe', 'auto-edit', 'yolo'].includes(argument)) {
          props.toolContext.permissions.setMode(argument as 'safe' | 'auto-edit' | 'yolo');
          push({ kind: 'notice', level: 'info', text: `Permission mode: ${argument}` });
          break;
        }
        const approved = props.toolContext.permissions.listApproved();
        push({
          kind: 'raw',
          text: [
            `Mode: ${props.toolContext.permissions.getMode()}`,
            '  safe       confirm every write and shell command',
            '  auto-edit  writes apply; shell confirmed (default)',
            '  yolo       nothing prompts except dangerous commands',
            '',
            approved.length ? `Remembered approvals:\n${approved.map((a) => `  ${a}`).join('\n')}` : 'No remembered approvals.',
            '',
            'Change with /permissions safe|auto-edit|yolo',
          ].join('\n'),
        });
        break;
      }

      case 'sessions': {
        const sessions = props.store.list(props.toolContext.cwd, 10);
        push({
          kind: 'raw',
          text: sessions.length
            ? sessions
                .map(
                  (s) =>
                    `  ${s.id.slice(0, 8)}  ${new Date(s.updatedAt).toLocaleString()}  ${formatCost(s.cost).padStart(9)}  ${s.title ?? '(untitled)'}`,
                )
                .join('\n') + '\n\nResume with: forge --resume <id>'
            : 'No previous sessions in this directory.',
        });
        break;
      }

      case 'context': {
        const status = assessContext(
          [...props.conversation.messages],
          Math.ceil(props.conversation.system.length / 3.6),
          model.entry.contextWindow,
          props.config.limits.contextWarnPct,
          props.config.limits.contextTrimPct,
        );
        push({
          kind: 'raw',
          text: [
            `Estimated context: ${status.estimatedTokens.toLocaleString()} / ${status.contextWindow.toLocaleString()} tokens (${Math.round(status.ratio * 100)}%)`,
            `Messages: ${props.conversation.length}`,
            `Prompt prefix fingerprint: ${props.conversation.prefixFingerprint()}`,
            '',
            'The fingerprint covers the system prompt and tool schemas. It must stay',
            'constant for the whole session — if it ever changes, the prompt cache resets.',
          ].join('\n'),
        });
        break;
      }

      case 'memory':
        push({
          kind: 'notice',
          level: 'info',
          text: 'Cross-session memory arrives in M2. For now, project conventions in AGENTS.md or CLAUDE.md are loaded automatically at startup.',
        });
        break;

      case 'exit':
      case 'quit':
        exit();
        break;

      default:
        push({
          kind: 'error',
          message: `Unknown command /${command}`,
          hint: `Try: ${SLASH_COMMANDS.map((c) => c.name).join(', ')}`,
        });
    }
  }

  // --- Render -------------------------------------------------------------
  const contextRatio = useMemo(() => {
    const status = assessContext(
      [...props.conversation.messages],
      Math.ceil(props.conversation.system.length / 3.6),
      model.entry.contextWindow,
      props.config.limits.contextWarnPct,
      props.config.limits.contextTrimPct,
    );
    return status.ratio;
  }, [props.conversation.length, model, history.length, props.config, props.conversation]);

  return (
    <Box flexDirection="column">
      <Static items={history}>{(item) => <HistoryItem key={item.id} item={item} />}</Static>

      {/* Live region — re-renders on every token, so it stays small. */}
      {streamText ? (
        <Box marginTop={1}>
          <Markdown>{streamText}</Markdown>
        </Box>
      ) : null}

      {!streamText && reasoning ? <Reasoning text={reasoning} /> : null}

      {running.map((tool) => (
        <ToolCall key={tool.id} name={tool.name} summary={tool.summary} state="running" />
      ))}

      <TodoList todos={todos} />

      {pending ? <Confirm request={pending} onDecide={decide} /> : null}

      {busy && !pending ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>{SPINNER_FRAMES[spinner]} </Text>
          <Text color={theme.dim}>working… (ctrl-c to interrupt)</Text>
        </Box>
      ) : null}

      {!pending && !busy ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={theme.user} bold>
              {glyphs.user}{' '}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(value) => void submit(value)}
              placeholder="ask, or /help"
            />
          </Box>
          <StatusBar
            modelKey={model.key}
            tier={model.tier}
            cost={totals.cost}
            contextRatio={contextRatio}
            interruptArmed={interruptArmed}
            subscription={model.entry.subscription}
          />
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------

function HistoryItem({ item }: { item: Item }): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return <UserMessage text={item.text} />;
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Markdown>{item.text}</Markdown>
        </Box>
      );
    case 'tool':
      return (
        <ToolCall
          name={item.name}
          summary={item.summary}
          state={item.state}
          detail={item.detail}
          display={item.display}
          durationMs={item.durationMs}
        />
      );
    case 'notice':
      return <Notice level={item.level} message={item.text} />;
    case 'error':
      return <ErrorMessage message={item.message} hint={item.hint} />;
    case 'cost':
      return item.payload;
    case 'raw':
      return (
        <Box marginTop={1} flexDirection="column">
          {item.text.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );
  }
}

function StatusBar({
  modelKey,
  tier,
  cost,
  contextRatio,
  interruptArmed,
  subscription,
}: {
  modelKey: string;
  tier?: TierName;
  cost: number;
  contextRatio: number;
  interruptArmed: boolean;
  subscription: boolean;
}): React.ReactElement {
  const pct = Math.round(contextRatio * 100);
  return (
    <Box>
      <Text color={theme.dim}>
        {modelKey}
        {tier ? ` (${tier})` : ''}
        {'  '}
        {subscription ? 'subscription' : formatCost(cost)}
        {pct >= 50 ? `  ctx ${pct}%` : ''}
        {interruptArmed ? '  press ctrl-c again to exit' : ''}
      </Text>
    </Box>
  );
}

function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(text);
  return (match?.[1] ?? text).slice(0, 90);
}
