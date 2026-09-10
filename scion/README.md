# Scion — a powerful successor, on the Claude Agent SDK

This repository was built by Claude (`claude-fable-5`). Scion is the answer to
"can you make a powerful successor to yourself": an autonomous agent harness
built on the **Claude Agent SDK** — the full Claude Code harness (file tools,
search, subagents, permissions) packaged as a library — that runs missions on
the most capable model in the lineage, `claude-fable-5-1`, the literal
successor of the model that wrote this code.

Honest framing: a model cannot train its own successor from a repo. What it
*can* build is the next best thing — an agent that puts a stronger model than
its author to work, with tools, subagents, budgets and a full mission ledger.

## Quickstart

```bash
npm install                 # installs @anthropic-ai/claude-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...   # or `claude` login / ANTHROPIC_AUTH_TOKEN

npm run scion -- "audit fare/logic.mjs and report edge cases"
npm run scion -- --trust "run the test suite and fix what fails"
npm run scion -- status     # which harness would run right now, and why
```

No SDK or no credentials? Nothing breaks: the deterministic **understudy**
rehearses the mission instead (mission accepted, succession plan printed),
so the CLI and tests run anywhere — same doctrine as `automaton/`'s offline
brain.

## Flags

| Flag | Meaning | Default |
|---|---|---|
| `--model <id>` | model to run | `claude-fable-5-1` |
| `--max-turns <n>` | turn ceiling (SDK-enforced) | 30 |
| `--budget <usd>` | spend ceiling (SDK-enforced) | $5 |
| `--cwd <dir>` | mission working directory | process cwd |
| `--effort <level>` | `low`…`max` reasoning depth | `xhigh` |
| `--trust` | allow the `Bash` tool | off |
| `--yolo` | bypass permissions entirely | off — isolated environments only |

## The lineage

The succession ladder, most capable first — a mission prefers the top and can
fall a rung when a model is unavailable:

| Rung | Model | $/MTok in → out |
|---|---|---|
| the scion | `claude-fable-5-1` | 10 → 50 |
| the regent | `claude-opus-5` | 5 → 25 |
| the envoy | `claude-sonnet-5` | 2 → 10 |
| the page | `claude-haiku-4-5` | 1 → 5 |

## The court

Two subagents are always on retainer (defined via the SDK's `agents` option):

- **scout** — read-only researcher on `claude-sonnet-5`: finds and reads, never writes.
- **auditor** — adversarial reviewer on the mission's own model: tries to refute
  the work before it ships.

## Safety posture

- Default tools are read/search/edit/web only — **no `Bash`** unless `--trust`.
- `--yolo` (bypass permissions) exists for sandboxes and CI containers only.
- Turn and dollar ceilings are enforced by the SDK (`maxTurns`, `maxBudgetUsd`);
  the ledger meters an independent dollar estimate per turn as a cross-check.
- The scion's constitution (appended to the system prompt) binds it to honest,
  minimal, reversible work inside the mission directory.

## Architecture (house rules)

- `logic.mjs` — the pure succession engine: lineage, dollar metering, mission
  ledger, guardrails, SDK options mapping, argv parsing, debrief. No I/O, no
  clock; callers pass `now`.
- `harness.mjs` — the live Claude Agent SDK adapter + understudy fallback.
  Process-neutral: no `process.exit`, loggers injected.
- `scion.mjs` — the CLI.
- Tests: `npm run test:scion` → `scripts/test-scion-logic.mjs` (14 tests, part
  of root `npm test`).
