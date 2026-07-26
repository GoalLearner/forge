/**
 * Task list tool.
 *
 * A surprisingly large share of "the agent felt reliable" comes from this. On a
 * multi-step task an explicit checklist keeps a cheap model from drifting,
 * declaring victory early, or silently dropping the third of four requested
 * changes — the failure modes that make small models feel untrustworthy.
 *
 * CACHE NOTE: the list lives in tool results, which are append-only, NOT in the
 * system prompt. Injecting mutable state into the system prompt would rewrite
 * the cached prefix on every update — see agent/messages.ts for why that is
 * expensive enough to matter.
 */

import type { Tool, ToolResult } from './types.ts';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
}

/**
 * Session-scoped todo state. Owned by the CLI so the UI can render it
 * alongside the transcript, and passed into the tool by factory.
 */
export class TodoStore {
  private todos: Todo[] = [];
  private listeners = new Set<(todos: Todo[]) => void>();

  get(): Todo[] {
    return this.todos;
  }

  set(todos: Todo[]): void {
    this.todos = todos;
    for (const listener of this.listeners) listener(todos);
  }

  clear(): void {
    this.set([]);
  }

  subscribe(listener: (todos: Todo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Compact one-line summary for the status bar. */
  summary(): string | null {
    if (this.todos.length === 0) return null;
    const done = this.todos.filter((t) => t.status === 'completed').length;
    const active = this.todos.find((t) => t.status === 'in_progress');
    const progress = `${done}/${this.todos.length}`;
    return active ? `${progress} — ${active.content}` : progress;
  }
}

export function createTodoTool(store: TodoStore): Tool {
  return {
    name: 'todo_write',
    description:
      'Record or update the task list for the current request. Use it for any task needing three or more steps: write the full list up front, then re-send the whole list with updated statuses as you go. Mark exactly one item in_progress at a time, and mark each completed as soon as it is done — not in a batch at the end. Skip this for single-step tasks.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete task list. This replaces the previous list entirely.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Imperative description of the step.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },

    summarize(input) {
      const todos = Array.isArray(input.todos) ? (input.todos as Todo[]) : [];
      const done = todos.filter((t) => t.status === 'completed').length;
      return `todos ${done}/${todos.length}`;
    },

    // Purely internal bookkeeping — nothing to confirm, nothing to undo.
    permission: () => null,

    async execute(input): Promise<ToolResult> {
      const raw = Array.isArray(input.todos) ? input.todos : [];
      const todos: Todo[] = raw
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .map((t) => ({
          content: String(t.content ?? '').trim(),
          status: normalizeStatus(t.status),
        }))
        .filter((t) => t.content.length > 0);

      store.set(todos);

      if (todos.length === 0) return { content: 'Task list cleared.' };

      // Echo the list back so the model can see its own state without a second
      // call. Compact on purpose — this is re-sent on every later turn.
      const rendered = todos
        .map((t) => `${statusMark(t.status)} ${t.content}`)
        .join('\n');
      const done = todos.filter((t) => t.status === 'completed').length;

      return { content: `Task list (${done}/${todos.length} done):\n${rendered}` };
    },
  };
}

function normalizeStatus(value: unknown): TodoStatus {
  const text = String(value ?? '').toLowerCase();
  if (text === 'completed' || text === 'done') return 'completed';
  if (text === 'in_progress' || text === 'in-progress' || text === 'active') return 'in_progress';
  return 'pending';
}

function statusMark(status: TodoStatus): string {
  switch (status) {
    case 'completed':
      return '[x]';
    case 'in_progress':
      return '[>]';
    case 'pending':
      return '[ ]';
  }
}
