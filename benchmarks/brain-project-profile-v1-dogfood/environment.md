# Environment

- OS: win32 10.0.19045 · Node v24.15.0
- Model: deepseek/deepseek-v4-pro (availability: authenticated non-completion GET /models,
  HTTP 200, id present; no completion issued pre-schedule)
- Permission mode: yolo (both arms; headless auto-denies approvals, so a mutation dogfood
  cannot run in safe/auto-edit — disposable clones + post-run path audit compensate)
- Control build: 16ef34b worktree (531/531) · Treatment build: 9ce342e worktree (582/582 ×3)
- pnpm: NOT installed → P2 uses npm with a qualified `test:unit` fallback (deviation
  documented in protocol.md before freeze)
- Fixture deps: `node_modules` junction to the Forge repo install (tsc + types); junction
  recreated per run clone; never committed
- Credential: DEEPSEEK_API_KEY read from env at call time; never stored in artifacts
- Isolation: fresh git clone + fresh FORGE_HOME per scored run; no shared history
