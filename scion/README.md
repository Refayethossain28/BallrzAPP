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
export ANTHROPIC_API_KEY=sk-ant-...   # or a stored `claude` login (see note)

npm run scion -- "audit fare/logic.mjs and report edge cases"
npm run scion -- --trust "run the test suite and fix what fails"
npm run scion -- status     # which harness would run right now, and why
```

> Credentials note: scion goes live when it sees `ANTHROPIC_API_KEY`,
> `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, or a stored `claude`
> login credentials file (`~/.claude/.credentials.json`). A keychain-only
> login (macOS) is invisible to the gate — run `claude setup-token` or
> export a key. `scion status` tells you which harness would run.

No SDK or no credentials? Nothing breaks: the deterministic **understudy**
rehearses the mission instead (mission accepted, succession plan printed),
so the CLI and tests run anywhere — same doctrine as `automaton/`'s offline
brain.

## The mission console (web app)

A phone-friendly UI over the same engine — write a brief, pick the powers,
watch the run arrive line by line, read the debrief:

```bash
npm run scion:web        # http://localhost:8798
```

The mission agent can edit files on the host, so the server binds
`127.0.0.1` by default. To drive it from an iPhone on your own network:

```bash
HOST=0.0.0.0 npm run scion:web   # then open http://<computer-ip>:8798 — trusted networks only
```

Zero dependencies (`node:http`), one mission at a time, in-memory history.
Same posture rules as the CLI: web and bash are opt-in toggles, yolo asks
for confirmation and is container-only.

## Flags

| Flag | Meaning | Default |
|---|---|---|
| `--model <id>` | model to run | `claude-fable-5-1` |
| `--max-turns <n>` | turn ceiling (SDK-enforced) | 30 |
| `--budget <usd>` | spend ceiling (SDK-enforced) | $5 |
| `--cwd <dir>` | mission working directory | process cwd |
| `--effort <level>` | `low`…`max` reasoning depth | `xhigh` |
| `--web` | allow `WebSearch`/`WebFetch` | off |
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

What the code actually enforces — and what it doesn't:

- The default tool surface is `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Agent`,
  `TaskCreate`, `TaskUpdate` — restricted via the SDK's `tools` option, so
  `Bash` and the web tools are absent from the surface, not merely denied.
  `--trust` adds `Bash`; `--web` adds `WebSearch`/`WebFetch`.
- Web tools are off by default deliberately: fetched pages are untrusted input
  to an agent whose edits are auto-accepted. Turning on `--web` accepts that
  pairing — prefer running such missions in a container.
- **Edits are auto-accepted and not path-scoped.** A mission can write anywhere
  the process user can (including outside `--cwd`). The constitution instructs
  the agent to stay inside the mission directory, but an instruction is not a
  sandbox — run missions you don't fully trust in a container.
- `--yolo` (bypass permissions, full tool surface) is for isolated containers
  only; the CLI prints a warning and the debrief records the powers used.
- Turn and dollar ceilings are enforced by the SDK (`maxTurns`, `maxBudgetUsd`);
  the ledger meters an independent dollar estimate per turn as a cross-check.
- Model output echoed to the terminal is stripped of ANSI/control characters,
  so web-sourced escape sequences can't rewrite the transcript.
- The understudy path is pure and network-free — it can never spend money.

## Architecture (house rules)

- `logic.mjs` — the pure succession engine: lineage, dollar metering, mission
  ledger, guardrails, SDK options mapping, argv parsing, debrief. No I/O, no
  clock; callers pass `now`.
- `harness.mjs` — the live Claude Agent SDK adapter + understudy fallback.
  Process-neutral: no `process.exit`, loggers injected.
- `scion.mjs` — the CLI. `server.mjs` + `index.html` — the mission console
  (zero-dep `node:http` API + smoke-test-clean single-file page).
- Tests: `npm run test:scion` → `scripts/test-scion-logic.mjs` (23 tests, part
  of root `npm test`; the console page is covered by the prototype smoke test).
