/**
 * Presentational components for the transcript.
 *
 * Design rule: the user should be able to tell what kind of thing each line is
 * from its glyph and color alone, without reading it. Tool calls are one dense
 * line unless something went wrong or there's a diff to show — an agent that
 * prints six lines per file read buries the actual answer.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, theme } from './theme.ts';
import type { ToolDisplay } from '../tools/types.ts';
import type { Todo } from '../tools/todo.ts';

// ---------------------------------------------------------------------------
// User input echo
// ---------------------------------------------------------------------------

export function UserMessage({ text }: { text: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.user} bold>
        {glyphs.user}{' '}
      </Text>
      <Text color={theme.user}>{text}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface ToolCallProps {
  name: string;
  summary: string;
  state: 'running' | 'ok' | 'error';
  /** Result text — only rendered when it failed, to keep the transcript tight. */
  detail?: string;
  display?: ToolDisplay;
  durationMs?: number;
}

export function ToolCall({
  name,
  summary,
  state,
  detail,
  display,
  durationMs,
}: ToolCallProps): React.ReactElement {
  const color =
    state === 'running' ? theme.toolRunning : state === 'ok' ? theme.toolOk : theme.toolError;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{glyphs.tool} </Text>
        <Text color={theme.dim}>{name} </Text>
        <Text>{summary}</Text>
        {durationMs !== undefined && durationMs > 1000 ? (
          <Text color={theme.dim}> ({(durationMs / 1000).toFixed(1)}s)</Text>
        ) : null}
      </Box>

      {display?.kind === 'diff' ? <DiffView display={display} /> : null}

      {/* Only failures print their body. Successes are self-evident from the
          summary line, and echoing them doubles the transcript for no gain. */}
      {state === 'error' && detail ? (
        <Box paddingLeft={2} flexDirection="column">
          {detail
            .split('\n')
            .slice(0, 8)
            .map((line, i) => (
              <Text key={i} color={theme.toolError} dimColor>
                {line}
              </Text>
            ))}
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export function DiffView({
  display,
}: {
  display: Extract<ToolDisplay, { kind: 'diff' }>;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={theme.added}>+{display.added} </Text>
        <Text color={theme.removed}>-{display.removed} </Text>
        <Text color={theme.dim}>{display.path}</Text>
      </Box>
      {display.patch.split('\n').map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
    </Box>
  );
}

function DiffLine({ line }: { line: string }): React.ReactElement {
  if (line.startsWith('@@')) return <Text color={theme.hunk}>{line}</Text>;
  if (line.startsWith('+')) return <Text color={theme.added}>{line}</Text>;
  if (line.startsWith('-')) return <Text color={theme.removed}>{line}</Text>;
  if (line.startsWith('...')) return <Text color={theme.dim}>{line}</Text>;
  return <Text color={theme.dim}>{line}</Text>;
}

// ---------------------------------------------------------------------------
// Notices and errors
// ---------------------------------------------------------------------------

export function Notice({
  level,
  message,
}: {
  level: 'info' | 'warn';
  message: string;
}): React.ReactElement {
  const color = level === 'warn' ? theme.notice : theme.dim;
  return (
    <Box marginTop={1}>
      <Text color={color}>{glyphs.notice} </Text>
      <Text color={color}>{message}</Text>
    </Box>
  );
}

export function ErrorMessage({
  message,
  hint,
}: {
  message: string;
  hint?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.error} bold>
          {glyphs.error}{' '}
        </Text>
        <Text color={theme.error}>{message}</Text>
      </Box>
      {hint ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

export function TodoList({ todos }: { todos: Todo[] }): React.ReactElement | null {
  if (todos.length === 0) return null;
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      {todos.map((todo, i) => {
        const mark =
          todo.status === 'completed'
            ? glyphs.done
            : todo.status === 'in_progress'
              ? glyphs.active
              : glyphs.pending;
        const color =
          todo.status === 'completed'
            ? theme.dim
            : todo.status === 'in_progress'
              ? theme.toolRunning
              : undefined;
        return (
          <Text key={i} color={color} strikethrough={todo.status === 'completed'}>
            {mark} {todo.content}
          </Text>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

/**
 * Thinking output, shown live and then discarded — it is never persisted to the
 * transcript or sent back to the provider. Capped to the last few lines so a
 * verbose reasoning model doesn't push the actual answer off screen.
 */
export function Reasoning({ text }: { text: string }): React.ReactElement | null {
  if (!text.trim()) return null;
  const lines = text.trimEnd().split('\n').slice(-3);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, i) => (
        <Text key={i} color={theme.reasoning} dimColor>
          {glyphs.reasoning} {line.slice(0, 100)}
        </Text>
      ))}
    </Box>
  );
}
