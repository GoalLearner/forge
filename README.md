# forge

A coding agent CLI built to run cheap. Claude Code-style UX, driven by GLM / Kimi / DeepSeek / local models, with frontier models available as an opt-in escalation.

```
> fix the failing test in src/parser.ts

● grep "describe(" in src/parser.test.ts
● read src/parser.ts from line 40
● edit src/parser.ts
  +3 -1 src/parser.ts
  @@ -47,7 +47,9 @@
  -  return tokens.slice(1);
  +  if (tokens.length === 0) return [];
  +  return tokens.slice(1);
● npm test -- parser

The test was failing on empty input — `tokens.slice(1)` returned undefined
downstream. Guarded it and the suite is green.

  deepseek/deepseek-v4-pro (cheap)  $0.0021  ctx 12%
```

---

## Why this is cheap

Not because the models are cheap — although they are. Because of **where the tokens go.**

An agent loop resends the whole conversation on every turn. A task with 20 tool calls sends the transcript 20 times, so a session costs roughly `tokens × price × turns`. The only lever that moves that by an order of magnitude is the provider's prompt cache:

| Model | Input | **Cached input** | Output | Discount |
|---|---|---|---|---|
| DeepSeek V4 Flash | $0.14 | **$0.0028** | $0.28 | **50×** |
| DeepSeek V4 Pro | $0.435 | **$0.0036** | $0.87 | **120×** |
| Kimi K2.5 | $0.60 | $0.10 | $3.00 | 6× |
| GLM-4.7 | $0.40 | $0.11 | $1.75 | 4× |
| Claude Opus 5 | $5.00 | $0.50 | $25.00 | 10× |

*Per 1M tokens, verified 2026-07-25. See [Model catalog](#model-catalog) — these change often.*

Every one of those caches is a **prefix byte match**. Not semantic — a literal comparison of the serialized request from position zero. Change one byte near the front and everything after it bills at full price, with no error and no warning.

So forge is built around keeping that prefix stable. Requests are assembled in strict volatility order:

```
[ system prompt   ]  frozen at session start — no clock, no counters, no state
[ tool schemas    ]  sorted by name, deterministically serialized
[ conversation    ]  append-only
```

The rules that follow, and what breaks if you ignore them, are documented at length in [`src/agent/messages.ts`](src/agent/messages.ts) — that file and [`src/agent/loop.ts`](src/agent/loop.ts) are the two worth reading first if you want to extend this.

**`/cost` shows your cache hit rate**, because that single number tells you whether any of this is working. A healthy multi-turn session sits at 70–95%. If yours is near zero after a few turns, something is invalidating the prefix and you're paying up to 50× more than you should be.

---

## Install

Needs **Node 22.5+** (uses the built-in `node:sqlite`, so there are no native dependencies and no compiler toolchain required).

```bash
git clone <this repo> forge && cd forge
npm install
npm run build
npm link
```

Then set one API key and go:

```bash
export DEEPSEEK_API_KEY=sk-...   # PowerShell: $env:DEEPSEEK_API_KEY="sk-..."
forge
```

That's the whole setup. Config files are optional.

### Desktop app (Windows)

There's a full desktop UI as well as the terminal one — same agent core, running
in Electron's main process (no localhost server, so nothing is listening on a
port).

```bash
npm run app          # build and launch, for development
npm run dist:app     # build release/Forge-Setup-<version>.exe
```

`dist:app` produces a per-user NSIS installer (no admin prompt) with Start-menu
and desktop shortcuts. It needs no key at install time: launched without one,
the app opens into its first-run key setup and writes to `~/.forge/keys.json`.
Uninstalling deliberately leaves `~/.forge/` alone, so your sessions and cost
history survive a reinstall.

The app icon is generated from the same geometry as Forge's in-app avatar —
`npm run icon` rewrites `build/icon.ico`, so there's no committed binary to
keep in sync.

Two packaging details that are easy to get wrong, both handled:

- **ripgrep is unpacked from the asar.** You cannot `spawn()` an executable that
  only exists inside `app.asar`, so `@vscode/ripgrep*` is listed in
  `asarUnpack` and `src/tools/search.ts` redirects the path to
  `app.asar.unpacked`. Without both halves, `grep` fails only in the installed
  build — never in development.
- **JetBrains Mono ships as local `woff2`.** The renderer's CSP forbids outside
  requests, so a webfont fetched from a CDN would silently fall back to
  Consolas.

---

## Configuring cheap models

Config lives at `~/.forge/config.toml` (global) and `./.forge/config.toml` (per-project). Project settings win. Every provider below is preconfigured — you normally only write a `[tiers]` block.

### DeepSeek — cheapest per token, best caching

```toml
[tiers]
fast   = "deepseek/deepseek-v4-flash"
cheap  = "deepseek/deepseek-v4-pro"
strong = "deepseek/deepseek-v4-pro"
```
```bash
export DEEPSEEK_API_KEY=sk-...
```

The caching discount here is extreme (50–120×), which makes DeepSeek disproportionately good in an agent loop specifically — more so than the headline per-token price suggests.

### GLM Coding Plan — flat monthly, likely the cheapest overall

$10–80/month for a fixed pool of prompts. Marginal token cost is **zero**, so a heavy day costs the same as a light one.

```toml
[tiers]
fast   = "zai-coding-plan/glm-4.5-air"
cheap  = "zai-coding-plan/glm-4.7"
strong = "zai-coding-plan/glm-4.7"
```
```bash
export ZAI_API_KEY=...
```

This routes through Z.ai's Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic`). `/cost` reports $0.00 for these models on purpose — they're already paid for.

### GLM — metered, pay per token

```toml
[tiers]
fast   = "zai/glm-4.5-air"
cheap  = "zai/glm-4.7"
strong = "zai/glm-5.2"
```
```bash
export ZAI_API_KEY=...
```

### Kimi

```toml
[tiers]
fast   = "moonshot/kimi-k2.5"
cheap  = "moonshot/kimi-k2.7-code"
strong = "moonshot/kimi-k3"
```
```bash
export MOONSHOT_API_KEY=sk-...
```

### Ollama — local, free

```bash
ollama serve
ollama pull qwen3-coder
```
```toml
[tiers]
fast  = "ollama/qwen3-coder"
cheap = "ollama/qwen3-coder"
```

No key needed. Local models are meaningfully weaker at tool calling than the cloud cheap tier — usable for the `fast` tier (summarizing, commit messages), rough as the main driver.

### Mixed: cheap driver + frontier escalation

The setup this tool was designed around. Everything runs cheap; you reach for the expensive model deliberately.

```toml
[tiers]
fast   = "deepseek/deepseek-v4-flash"
cheap  = "deepseek/deepseek-v4-pro"
strong = "anthropic/claude-opus-5"
```
```bash
export DEEPSEEK_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

### Anything else

Any OpenAI- or Anthropic-compatible endpoint works. Add a provider and a model:

```toml
[providers.myhost]
kind    = "openai"                       # wire format: "openai" or "anthropic"
baseURL = "https://api.example.com/v1"
apiKey  = "env:MY_API_KEY"

[models."myhost/some-model"]
provider      = "myhost"
model         = "some-model"
contextWindow = 128000
maxOutput     = 8192
autoCache     = true
pricing       = { input = 0.5, cachedInput = 0.05, output = 1.5 }
```

`openrouter` and `openai` are also preconfigured.

---

## Routing and cost control

Three tiers, switched manually. There is deliberately **no automatic escalation** in this version — you should see how the cheap tier actually performs on your work before anything starts spending your money on your behalf.

| Tier | For | Typical |
|---|---|---|
| `fast` | Summarizing, commit messages, ranking | DeepSeek V4 Flash |
| `cheap` | **Everything, by default** | DeepSeek V4 Pro, GLM-4.7 |
| `strong` | Hard debugging, architecture, when cheap is stuck | Claude Opus 5 |

```
/model              show current model and all tiers
/model strong       escalate this session
/model cheap        come back
/model deepseek/deepseek-v4-flash    pick an exact model
```

Switching models resets the prompt cache — caches are per-model — so forge tells you when that happens rather than letting you wonder where your hit rate went.

**Other levers:**

- `/cost` in a session, or `forge --cost` from the shell — today / this directory / all-time, per-model breakdown, cache hit rate, and what caching saved you
- `/context` — how full the window is, plus the prefix fingerprint (it must never change mid-session)
- `/clear` — start fresh when a task is done; a stale 80%-full context costs money on every turn
- `limits.maxSteps` in config — caps how many turns one request can spend

Costs are estimates from the local model catalog. Check your provider's dashboard for the authoritative number.

---

## Using it

```bash
forge                            # interactive
forge "fix the failing test"     # one-shot, prints and exits
forge --continue                 # resume the last session in this directory
forge --resume <id>              # resume a specific session
forge --sessions                 # list recent sessions
forge --cost                     # spend and cache hit rate
forge --cost --json              # the same, machine-readable
forge --model strong             # start on a specific tier
forge --permission-mode safe     # start in a specific mode
```

`--cost` and `--sessions` don't resolve a model, so checking your spend never requires a working API key.

```
$ forge --cost
Usage

  Cache hit rate   70.2%   46.2k of 65.8k input tokens
  Caching saved    $0.0199  ($0.0299 uncached → $0.00998, 66.6% off)

  Today              $0.00998   65.8k in / 1.5k out   8 req
  This directory     $0.00998   65.8k in / 1.5k out   8 req
  All time           $0.00998   65.8k in / 1.5k out   8 req
```

### One-shot mode and pipes

`forge -p "..."` (or a bare `forge "..."`) skips the TUI entirely and splits its output so it composes in a shell:

- **stdout** — the answer, and nothing else
- **stderr** — tool activity, warnings, and a one-line cost summary

```bash
forge -p "summarize the changes on this branch" > notes.md
forge -p "what does src/parser.ts do?" 2>/dev/null | less
```

Permission prompts are **auto-denied** in one-shot mode, since nothing can answer them and blocking forever is worse. Add `--permission-mode yolo` for unattended writes, or pre-approve the actions once in an interactive session.

### Commands

| | |
|---|---|
| `/help` | Commands and keys |
| `/model [tier\|id]` | Show or switch model |
| `/cost` | Usage, cost, cache hit rate |
| `/context` | Context usage and prefix fingerprint |
| `/clear` | Wipe the conversation |
| `/tools` | List tools |
| `/permissions [mode]` | Show or change permission mode |
| `/sessions` | Recent sessions here |
| `/exit` | Quit |

**Ctrl-C** interrupts the current turn; the session stays usable. Twice at idle exits.

### Tools

`read_file` · `write_file` · `edit_file` · `multi_edit` · `list_dir` · `glob` · `grep` · `run_shell` · `git_status` · `git_diff` · `git_log` · `git_commit` · `todo_write`

ripgrep is bundled — nothing to install.

---

## Safety

**Permission modes:**

| Mode | Writes | Shell |
|---|---|---|
| `safe` | confirm | confirm |
| `auto-edit` *(default)* | apply | confirm (read-only shell runs freely) |
| `yolo` | apply | run |

**Dangerous commands are always confirmed, in every mode** — including yolo. `rm -rf`, `del /s`, force pushes, `git reset --hard`, piped installers, `npm publish`, privilege escalation, disk operations. Accepting "run my tests without asking" is not the same as accepting "reformat my disk without asking", and collapsing those into one setting is how agents damage machines.

Approvals are remembered per command (`npm test` approves once, not forever-and-also-`npm publish`), stored in `.forge/permissions.json`, which is gitignored.

**Other rails:**

- **Path jail** — every file path is canonicalized (symlinks resolved) and confined to the project root. Traversal, symlink escapes, and sibling directories sharing the root's prefix are all rejected.
- **Credential blocking** — `.env`, `id_rsa`, `*.pem`, `.aws/credentials` and friends can't be read by default. They'd otherwise be shipped straight to a model provider.
- **Read before write** — a file that exists can only be modified if this session read it and it hasn't changed since. Stops the agent silently reverting edits you made in your editor.
- **Unique-match edits** — `edit_file` refuses an ambiguous match rather than guessing which `return null` you meant.

---

## Architecture

```
src/
  cli.tsx              entry: args, bootstrap, error paths
  config/
    schema.ts          config shape + built-in provider presets
    load.ts            layered TOML + env
    models.json        the model catalog — DATA, edit freely
  providers/
    types.ts           the abstraction: one normalized event stream
    openai.ts          ChatCompletions: DeepSeek, GLM, Kimi, Ollama, OpenRouter
    anthropic.ts       Messages: Anthropic, GLM Coding Plan, DeepSeek
    registry.ts        tier -> live client
    retry.ts           backoff; only retries before the first token
  agent/
    messages.ts        ⭐ cache-stable assembly — read this one
    loop.ts            ⭐ the agent loop — and this one
    json-repair.ts     salvages malformed tool arguments from cheap models
    truncate.ts        output caps + the context guard
    prompt.ts          system prompt (frozen at startup)
  tools/               the tool set + colored diffs
  safety/              path jail, danger classifier, permissions, read-before-write
  session/             SQLite persistence + cost accounting
  ui/                  Ink components
```

**Two wire formats cover everything.** DeepSeek and Z.ai each speak *both* OpenAI ChatCompletions and Anthropic Messages, so the "Anthropic" adapter isn't Anthropic-only — adding a provider is usually a config entry, not code.

### Things worth knowing before you extend it

- **Don't put anything dynamic in the system prompt.** A timestamp there costs 50× on DeepSeek, silently. `prompt.ts` captures time-like values once, at startup.
- **Don't register tools mid-session.** Tool schemas render at position 0; changing them invalidates the whole session's cache.
- **Serialize deterministically.** `util/stable-json.ts` exists so a tool call replayed from SQLite produces the same bytes as the in-memory original — otherwise `--resume` starts cold.
- **Append, don't rewrite.** The context guard does rewrite history, which is why it fires late (90% of the window) and in one batch, paying the cache reset once.

`src/agent/messages.test.ts` asserts these hold, and `src/agent/loop.integration.test.ts` verifies prefix stability against the actual bytes sent over the wire.

---

## Model catalog

`src/config/models.json` holds model IDs, context windows, and prices. **It will go stale** — DeepSeek deprecated `deepseek-chat` and `deepseek-reasoner` on 2026-07-24, GLM went 4.6 → 4.7 → 5.2 during 2026, and the legacy Kimi K2 family was retired in May.

You never need to wait for a release. Override or add anything in your own config:

```toml
# Correct a stale price
[models."deepseek/deepseek-v4-pro".pricing]
input = 0.40

# Add a model that doesn't exist here yet
[models."deepseek/deepseek-v5"]
provider      = "deepseek"
model         = "deepseek-v5"
contextWindow = 1000000
maxOutput     = 65536
autoCache     = true
pricing       = { input = 0.30, cachedInput = 0.003, output = 0.60 }
```

---

## Development

```bash
npm run typecheck
npm test           # 102 tests, no network, no API key needed
npm run build
npm run verify     # all three
```

The suite includes an end-to-end run of the agent loop against a mock OpenAI-compatible SSE server (`loop.integration.test.ts`) covering streaming, tool execution, permission denial, path-jail rejection, malformed-JSON recovery, and cache-usage reporting — so most regressions surface without spending a cent. One of those tests asserts prefix stability against the **actual bytes sent over the wire**, which is the property the whole cost model rests on.

---

## Not in this version

Deliberately scoped out of the first release, in rough priority order:

- Summarizing context compaction (there's a non-LLM guard that elides old tool results instead)
- Repo map / project indexing
- Cross-session memory (`AGENTS.md` / `CLAUDE.md` is loaded at startup)
- Plan mode with approve/reject/edit
- Automatic model routing and failure escalation
- Checkpoint / undo, PR creation

## License

MIT
