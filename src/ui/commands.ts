/**
 * Slash command catalog.
 *
 * Kept as data so /help and the "unknown command" hint can never drift out of
 * sync with what is actually implemented.
 */

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show this help' },
  {
    name: '/model',
    args: '[cheap|strong|fast|<provider>/<id>]',
    description: 'Show or switch the active model',
  },
  { name: '/cost', description: 'Token usage, cost, and cache hit rate' },
  { name: '/context', description: 'Context usage and the prompt-prefix fingerprint' },
  { name: '/clear', description: 'Wipe the conversation and start fresh' },
  { name: '/tools', description: 'List available tools' },
  {
    name: '/permissions',
    args: '[safe|auto-edit|yolo]',
    description: 'Show or change the permission mode',
  },
  { name: '/sessions', description: 'Recent sessions in this directory' },
  { name: '/memory', description: 'Cross-session memory (arrives in M2)' },
  { name: '/exit', description: 'Quit' },
];

export const HELP_TEXT = [
  'Commands:',
  ...SLASH_COMMANDS.map(
    (c) => `  ${`${c.name} ${c.args ?? ''}`.trim().padEnd(38)} ${c.description}`,
  ),
  '',
  'Keys:',
  '  ctrl-c        interrupt the current turn (twice at idle to exit)',
  '  y / a / n     answer a permission prompt (allow / always / deny)',
  '',
  'Cost control:',
  '  Everything runs on the "cheap" tier by default. /model strong escalates',
  '  a single session to a frontier model; /model cheap comes back.',
  '  /cost shows the cache hit rate — the number that actually determines',
  '  what a session costs. Healthy multi-turn sessions sit at 70-95%.',
].join('\n');
