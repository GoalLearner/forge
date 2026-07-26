/**
 * Tool registry.
 *
 * IMPORTANT: the registry is built once per session and never mutated.
 *
 * Tool schemas render at position 0 of every request, ahead of the system
 * prompt and the entire conversation. Registering or removing a tool
 * mid-session therefore invalidates the prompt cache for the whole session —
 * on DeepSeek that is a 50x cost increase with no visible symptom. If the tool
 * set genuinely needs to change, start a new session.
 */

import { editFileTool, multiEditTool, writeFileTool } from './fs-write.ts';
import { listDirTool, readFileTool } from './fs-read.ts';
import { gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool } from './git.ts';
import { globTool, grepTool } from './search.ts';
import { shellTool } from './shell.ts';
import { createTodoTool, TodoStore } from './todo.ts';
import type { Tool } from './types.ts';
import type { ToolSchema } from '../providers/types.ts';

export interface BuildToolsOptions {
  todoStore: TodoStore;
  /** Names to leave out, e.g. dropping run_shell for a read-only review session. */
  disabled?: string[];
}

export function buildTools(opts: BuildToolsOptions): Map<string, Tool> {
  const all: Tool[] = [
    readFileTool,
    listDirTool,
    globTool,
    grepTool,
    writeFileTool,
    editFileTool,
    multiEditTool,
    shellTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitCommitTool,
    createTodoTool(opts.todoStore),
  ];

  const disabled = new Set(opts.disabled ?? []);
  const registry = new Map<string, Tool>();
  for (const tool of all) {
    if (!disabled.has(tool.name)) registry.set(tool.name, tool);
  }
  return registry;
}

/**
 * Convert the registry into the wire-format schemas.
 * Sorted by name — see the cache note above; both adapters re-sort defensively,
 * but doing it here means the ordering is right by construction.
 */
export function toolSchemas(registry: Map<string, Tool>): ToolSchema[] {
  return [...registry.values()]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export { TodoStore };
