# Environment — Targeted Post-Edit Verification Dogfood v1

Recorded: 2026-07-26 (local), before any case execution.

## Host

| Item | Value |
|---|---|
| Operating system | Windows 10 Home 10.0.19045 |
| Node | v24.15.0 |
| npm | 11.12.1 |
| Shell | Git Bash / PowerShell |

## Frozen Forge build

| Item | Value |
|---|---|
| Repository | C:\Users\richm\OneDrive\Desktop\forge |
| Commit | 55b636c fix: correct verification attribution |
| Parent chain | 55b636c → 84133bd → 7392a4b → 9555b12 |
| Working tree at freeze | clean |
| typecheck | pass |
| build | pass |
| Full suite | 399 / 399 pass |
| Remote | none |
| Execution mode | production headless (`forge -p`) |

## Provider configuration (intended)

| Item | Value |
|---|---|
| Provider | deepseek (OpenAI wire format, https://api.deepseek.com) |
| Model key | deepseek/deepseek-v4-pro |
| Wire model id | deepseek-v4-pro |
| Context window | 1,000,000 |
| Pricing $/M (input / cachedInput / output) | 0.435 / 0.003625 / 0.87 |
| Credential | referenced as `env:DEEPSEEK_API_KEY`; never copied into artifacts |

## Limits in force (schema defaults, unmodified)

| Limit | Value |
|---|---|
| maxRetries (aggregate per run) | 4 |
| maxSteps | 50 |
| toolTimeoutMs | 120000 |
| maxRuntimeMs | 900000 |
| maxExplicitShellTimeoutMs | 600000 |
| Verification repair rounds | 2 (internal constant) |

## Isolated state

An isolated `FORGE_HOME` was created at
`%TEMP%\forge-tgt-v1\home` containing only a `config.toml` that references the
credential by environment indirection. No historical run-ledger rows are
present, so every measurement comes from this evaluation alone. The directory is
removable and does not affect normal Forge sessions.

## BLOCKER — provider unreachable from this environment

`api.deepseek.com` does not resolve from the execution environment:

```
api.deepseek.com     ENOTFOUND
github.com           ENOTFOUND
api.anthropic.com    reachable (status 404)
registry.npmjs.org   reachable (status 200)
```

- `dns.lookup('api.deepseek.com')` → `ENOTFOUND`; the allowlisted control host
  resolves normally.
- No `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` is configured.
- The failure persists with the tool sandbox disabled, so it is the
  environment's egress policy rather than a tool restriction.

Egress is selectively allowlisted and DeepSeek is not on the allowlist.
Consequently **no case in this evaluation could be executed**: all four scored
cases and the observation require real provider calls by definition.

Substituting a local mock provider was rejected. A mock would exercise Forge's
loop but would not measure *real model behaviour under the N7/N8 patterns*,
which is the entire question this evaluation exists to answer. Reporting mock
results under a "targeted real-provider rerun" heading would be exactly the
false-success failure mode this feature was built to prevent.

## Project-command discovery observation (no provider needed)

`awakened-app` (C:\Users\richm\Documents\repos\awakened-app, main, ada9252,
clean) declares only:

```
test:unit          node lib/economy.test.js
test:e2e           playwright test
test:e2e:headed    playwright test --headed
test:e2e:ui        playwright test --ui
test:e2e:report    playwright show-report
```

There is no `typecheck`, no `build`, and no plain `test` script. Forge's
verification-plan builder matches the exact script names `typecheck`, `test`,
`build` and `lint`, so against this repository it would select **no required
checks** and report `verification_unavailable`.

This was discovered while selecting targets and is recorded here because it is
real evidence gathered without a provider: the most-used real repository in this
project would receive no automatic verification at all under the current
discovery rules. It is a candidate for the highest-leverage remaining friction.
