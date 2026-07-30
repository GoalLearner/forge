/**
 * Shell command risk classifier.
 *
 * Purpose: decide whether a command must be confirmed *regardless* of the
 * user's permission mode. Someone running in `yolo` has accepted that `npm
 * test` runs unattended; they have not accepted `rm -rf ~` or a piped installer
 * from the internet.
 *
 * This is a safety net, not a sandbox. It is deliberately an ALLOW-list of
 * known-safe shapes plus a DENY-list of known-catastrophic ones, with
 * "unrecognized" landing in the middle rather than at either extreme — a
 * classifier that fails open on anything it doesn't recognize is worthless, and
 * one that fails closed on everything trains the user to stop reading prompts.
 *
 * Both POSIX and PowerShell/cmd forms are covered, because forge defaults to
 * PowerShell on Windows.
 */

export type RiskLevel = 'safe' | 'caution' | 'dangerous';

export interface RiskAssessment {
  level: RiskLevel;
  /** Human-readable explanations, shown verbatim in the confirmation prompt. */
  reasons: string[];
}

interface Rule {
  pattern: RegExp;
  reason: string;
}

/**
 * Irreversible, destructive, or trust-boundary-crossing. Always confirmed.
 */
const DANGEROUS_RULES: Rule[] = [
  // --- Recursive deletion -------------------------------------------------
  {
    pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r/i,
    reason: 'Recursive force delete (rm -rf) — not recoverable',
  },
  {
    pattern: /\brm\s+(-\S+\s+)*(\/|~|\$HOME|\*)\s*$/i,
    reason: 'Deleting a root, home, or wildcard path',
  },
  {
    // Flags can appear in any order, so `del /f /s /q` must match as readily as
    // `del /s`. Anchoring on the first flag missed the most common form.
    pattern: /\b(rd|rmdir)\b[^|;&]*\/s\b|\bdel\b[^|;&]*\/[sq]\b/i,
    reason: 'Recursive Windows delete (del /s, rd /s)',
  },
  {
    pattern: /Remove-Item[^|;]*-Recurse[^|;]*-Force|Remove-Item[^|;]*-Force[^|;]*-Recurse/i,
    reason: 'Recursive force delete (Remove-Item -Recurse -Force)',
  },

  // --- Disk / system ------------------------------------------------------
  { pattern: /\bmkfs(\.\w+)?\b|\bformat\s+[a-z]:/i, reason: 'Formatting a filesystem' },
  { pattern: /\bdd\s+[^|;]*\bof=/i, reason: 'Raw disk write with dd' },
  { pattern: /\bdiskpart\b/i, reason: 'Disk partitioning utility' },
  { pattern: /\b(shutdown|reboot|halt)\b/i, reason: 'Shutting down or rebooting the machine' },

  // --- Remote code execution ---------------------------------------------
  {
    pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i,
    reason: 'Piping a downloaded script straight into a shell',
  },
  {
    pattern: /\b(iex|Invoke-Expression)\b[\s(]*[^;]*\b(iwr|Invoke-WebRequest|DownloadString)\b/i,
    reason: 'Executing downloaded content (iex + web request)',
  },

  // --- Privilege / permissions -------------------------------------------
  { pattern: /^\s*sudo\b|\bsudo\s+(rm|dd|mkfs|chown|chmod)\b/i, reason: 'Running with elevated privileges' },
  { pattern: /\brunas\b|Start-Process[^;]*-Verb\s+RunAs/i, reason: 'Requesting Windows elevation' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: 'Making files world-writable' },
  { pattern: /Set-ExecutionPolicy/i, reason: 'Changing the PowerShell execution policy' },

  // --- Registry / system config ------------------------------------------
  {
    pattern: /\breg\s+(add|delete)\b|Set-ItemProperty[^;]*HK(LM|CU):/i,
    reason: 'Modifying the Windows registry',
  },

  // --- Irreversible git ---------------------------------------------------
  {
    pattern: /\bgit\s+push\b[^;]*(--force(?!-with-lease)|(?<![\w-])-f(?![\w-]))/i,
    reason: 'Force push — can destroy commits on the remote',
  },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard discards uncommitted work' },
  { pattern: /\bgit\s+clean\s+-[a-z]*[fd]/i, reason: 'git clean deletes untracked files' },
  { pattern: /\bgit\s+branch\s+-D\b/i, reason: 'Force-deleting a git branch' },

  // --- Publishing / outward-facing ---------------------------------------
  {
    pattern: /\b(npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i,
    reason: 'Publishing a package publicly — hard to undo',
  },
  { pattern: /\b(gh|glab)\s+release\s+create\b/i, reason: 'Creating a public release' },

  // --- Process / misc -----------------------------------------------------
  { pattern: /\btaskkill\b[^;]*\/f|\bkillall\b|\bpkill\s+-9/i, reason: 'Force-killing processes' },
  { pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: 'Fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/i, reason: 'Writing directly to a block device' },
];

/**
 * Worth a look but routine. In `safe` mode these prompt; in `auto-edit` and
 * `yolo` they do not.
 */
const CAUTION_RULES: Rule[] = [
  { pattern: /\bgit\s+push\b/i, reason: 'Pushes commits to a remote' },
  { pattern: /\bgit\s+commit\b/i, reason: 'Creates a commit' },
  {
    pattern: /\b(npm|yarn|pnpm)\s+(install|add|i)\b|\bpip\s+install\b|\bcargo\s+add\b/i,
    reason: 'Installs dependencies and may run install scripts',
  },
  { pattern: /\b(docker|kubectl)\b/i, reason: 'Container or cluster operation' },
  { pattern: /\b(mv|move|Move-Item)\b/i, reason: 'Moves or renames files' },
  { pattern: /\b(curl|wget|Invoke-WebRequest|iwr)\b/i, reason: 'Makes a network request' },
  { pattern: />>?\s*[^\s|&]+/, reason: 'Redirects output into a file' },
];

/**
 * Commands that read state and change nothing. Recognized so that the common
 * case doesn't nag. Anchored at the start and checked against each segment of a
 * compound command, so `ls && rm -rf /` is not classified by its first half.
 */
/**
 * Note that package managers appear here even though `npm install` is a caution
 * command: the caution rules are evaluated FIRST, so `npm install` is caught
 * there and only the harmless subcommands (`npm test`, `npm run build`) reach
 * this list. Omitting them entirely made every test run prompt, which is the
 * fastest way to train someone to stop reading prompts.
 */
const SAFE_COMMAND_HEADS = [
  'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'wc', 'echo',
  'grep', 'rg', 'find', 'fd', 'which', 'where', 'whoami', 'date', 'env',
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'make', 'tsc', 'tsx',
  'eslint', 'prettier', 'jest', 'vitest', 'pytest', 'mocha',
  'go', 'cargo', 'python', 'python3', 'pip', 'ruby', 'java', 'dotnet', 'mvn',
  'get-childitem', 'get-content', 'get-location', 'select-string', 'measure-object',
  'test-path', 'resolve-path',
  // Read-only PowerShell pipeline stages. Deliberately excludes where-object
  // and foreach-object: those take script blocks and can run anything.
  'select-object', 'sort-object', 'format-table', 'format-list', 'out-string',
];

const SAFE_GIT_SUBCOMMANDS = [
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'stash', 'blame',
  'rev-parse', 'ls-files', 'describe', 'shortlog', 'config',
];

export function assessCommand(command: string): RiskAssessment {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (normalized === '') return { level: 'safe', reasons: [] };

  const dangerous = DANGEROUS_RULES.filter((r) => r.pattern.test(normalized));
  if (dangerous.length > 0) {
    return { level: 'dangerous', reasons: dedupe(dangerous.map((r) => r.reason)) };
  }

  const caution = CAUTION_RULES.filter((r) => r.pattern.test(normalized));
  if (caution.length > 0) {
    return { level: 'caution', reasons: dedupe(caution.map((r) => r.reason)) };
  }

  // Every segment of a compound command must independently look read-only
  // before we call the whole thing safe.
  return allSegmentsReadOnly(normalized)
    ? { level: 'safe', reasons: [] }
    : { level: 'caution', reasons: ['Unrecognized command — review before running'] };
}

/**
 * Split a compound command on its separators, ignoring quoted text.
 *
 * A naive `.split(/\|/)` shreds an argument like
 * `-Pattern "fail|FAIL|Error"` into fragments that look nothing like commands,
 * so a wholly read-only pipeline gets classified as unrecognised. Quotes are
 * tracked so only real separators split.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '\n') {
      // Consume the second character of `||` so it is one separator, not two.
      if (ch === '|' && command[i + 1] === '|') i++;
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      i++;
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function allSegmentsReadOnly(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    const stripped = segment.replace(/^\(+\s*/, '');
    const head = stripped.split(/\s+/)[0]?.toLowerCase() ?? '';
    const bare = head.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/, '');

    if (bare === 'git') {
      const sub = stripped.split(/\s+/)[1]?.toLowerCase() ?? '';
      return SAFE_GIT_SUBCOMMANDS.includes(sub);
    }
    return SAFE_COMMAND_HEADS.includes(bare);
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
