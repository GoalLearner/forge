# Environment — Forge Dogfooding Benchmark v1

## Capture
- Date / local time: 2026-07-26 10:02 PDT (UTC-7)
- Operating system: Microsoft Windows 10 Home, build 19045
- Shell used by operator: Git Bash (MINGW64_NT-10.0-19045)
- Node: v24.15.0
- npm: 11.12.1

## Forge build under test
- Repository: C:\Users\richm\OneDrive\Desktop\forge
- Commit: 7392a4b "fix: correct ledger confidence and attempt accounting"
- Parents verified: 7f68a56, 9555b12
- Branch for benchmark artifacts: bench/dogfood-v1 (created from 7392a4b)
- Git remote: NONE configured (verified `git remote -v` empty) — push is impossible
- Build type: DEVELOPMENT build, run via the npm-linked CLI
  (`forge` -> C:\Users\richm\AppData\Roaming\npm\forge -> repo `dist/cli.js`).
  `dist/` was rebuilt from 7392a4b during Phase 1, so the linked binary IS the
  frozen build.
- Verified at freeze: `npm run typecheck` exit 0, `npm run build` exit 0,
  `npm test` 339/339 pass, 0 fail (matches the expected 339).

## Execution mode
- Normal tasks N1-N10: headless one-shot (`forge -p "<prompt>" --cwd <worktree>`).
  Chosen because it is deterministic, reuses the same central agent loop, and
  prints the run ledger to stderr on finalize.
- Adversarial tasks: mode recorded per task; packaged/desktop path used where
  safely possible, otherwise the reason is recorded.

## Configured model identity (effective)
Resolved from ~/.forge/config.toml [tiers] (secrets NOT read/recorded):
- fast   = deepseek/deepseek-v4-flash
- cheap  = deepseek/deepseek-v4-pro   <- THE DRIVER for every benchmark task
- strong = deepseek/deepseek-v4-pro   (intentionally same; no Anthropic key)
- Provider: deepseek
- Exact model id: deepseek-v4-pro
- Pricing used (models.json, USD / 1M): input 0.435, cachedInput 0.003625,
  output 0.87; autoCache true

## Limits in force (src/config/schema.ts defaults; config.toml overrides none)
- maxRetries (AGGREGATE per run): 4
- maxSteps: 50
- toolTimeoutMs: 120,000
- active runtime limit: 900,000 ms (15 min)
- shell timeout hard cap: 600,000 ms (10 min)
- maxToolOutputBytes: 30,000
- maxFileReadLines: 2,000
- permissions.mode default: auto-edit (benchmark passes an explicit mode per task)

## Credentials
- DEEPSEEK_API_KEY: present in operator environment (value never read, printed
  or stored). ~/.forge/keys.json: absent.
- No other provider key set (ANTHROPIC/MOONSHOT/ZAI/OPENAI all unset), so the
  real-provider tasks can only reach DeepSeek.

## Target repositories (canonical, must stay untouched)
- C:\Users\richm\OneDrive\Desktop\forge @ 7392a4b (clean at freeze)
- C:\Users\richm\Documents\repos\awakened-app @ ada9252 (clean at freeze)

## Benchmark working root
- C:\Users\richm\AppData\Local\Temp\forge-bench-20260726
- Deliberately OUTSIDE OneDrive: the Forge repo lives in a synced folder, and
  task worktrees must not be sync-mirrored mid-run.

## Environmental limitations recorded up front
1. Only one provider (DeepSeek) has a key, so provider-diversity is out of scope.
2. `strong` tier points at the same model as `cheap`, so escalation is a no-op.
3. awakened-app has a `.git/hooks/post-commit` hook that AUTO-PUSHES to origin.
   Worktrees share hooks, so any commit Forge makes there would be an external
   side effect. Mitigation: NO_AUTOPUSH=1 is exported for every Forge invocation
   in that repo (the hook's own documented escape hatch), tasks are designed not
   to require commits, and origin refs are compared before/after.
4. medellin-companion (Swift/Xcode) was rejected as a target: no runnable build
   or test on Windows, so no objective validation is possible.
5. pact-app was rejected: it contains only CLAUDE.md + HANDOFF.md and is not a
   git repository (verified) — no code to work on.
