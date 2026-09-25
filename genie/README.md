# Genie — the agent that does what you tell it

Genie is a personal, always-on AI agent that runs on **your own machine** (or
a server you control) and takes its orders from a phone-friendly web console.
You tell it what you want; it *does it* — with the full Claude Code tool set
through the **Claude Agent SDK**: shell, files, web search and fetch, subagents,
MCP. You watch it happen token by token, with live tool cards, a cost meter and
a stop button, and when it wants to do something you'd rather sign off on, the
approval lands on your phone — as does any question it has for you.

It remembers (a memory file it writes when you say *"remember…"*), it resumes
(multi-turn conversations, several side by side, all persisted on disk), it
runs standing orders on a clock (*"every weekday at 08:30 run the tests and
report"*), and it is governed by three trust levels — **Ask**, **Trust**,
**Auto** — that decide how much it pauses before acting. With no SDK or
credentials it doesn't pretend: a deterministic **rehearsal** replays what a
run looks like, executes nothing, and says so.

## Quickstart

```bash
npm install                            # installs @anthropic-ai/claude-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...    # or a stored `claude` login (see note)
npm run genie                          # http://127.0.0.1:8800

# the boot log prints the phone URL — open it on your phone:
#   http://<your-computer>:8800/?key=<key>
# Safari → Share → Add to Home Screen and it runs as its own app.
```

> Credentials note: Genie goes live when it sees `ANTHROPIC_API_KEY`,
> `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, or a stored `claude` login
> credentials file (`~/.claude/.credentials.json`). A keychain-only login
> (macOS) is invisible to the gate — run `claude setup-token` or export a key.
> `GET /api/status` (and the About panel) tell you which driver is running and
> why.

The key in the URL is the only lock on the door. It is read from `GENIE_KEY`
or created once at `~/.genie/key` (32 hex chars); the console stores it in
`localStorage` and strips it from the address bar. By default the server binds
`127.0.0.1`; to reach it from a phone on your own network run
`HOST=0.0.0.0 npm run genie` — on a network you trust.

## The three modes

| Mode | What it does | When to use it |
|---|---|---|
| **Ask** | Reads freely; every write, command and web call waits for your tap. | Unfamiliar code, someone else's machine, anything you want to watch closely. |
| **Trust** (default) | Acts freely; only destructive commands wait for your tap. | Day-to-day work in your own repos. |
| **Auto** | Never asks for permission — do whatever I tell it. Maps to the SDK's `bypassPermissions`. | Isolated containers and throwaway environments only. |

Switch with the header chips, `/mode <ask|trust|auto>`, or `GENIE_MODE`.

Whatever the mode, **a question is not a permission**. When the agent needs
you to choose or fill in a detail it calls `AskUserQuestion`, and that lands
on your phone as a question card — the question, one button per option, a
"Something else…" field, Answer / Decline — in every mode, Auto included. No
rule answers it for you; your answer goes back to the tool, a decline tells
the model you declined.

Auto has one precondition when the driver is live: the Claude Code CLI refuses
`bypassPermissions` for **root outside a declared sandbox**. Run Genie as a
non-root user, or set `IS_SANDBOX=1` inside a container you accept as
disposable. Otherwise the boot log says so, `/api/status` reports
`rootUnsandboxed` and an `autoBlockedReason`, the Auto chip is greyed, and
`/mode auto` (or `PATCH /api/settings`) is refused with a 400 rather than
letting every run fail with the CLI's own message.

**Rules.** "Always allow" from an approval card adds an **exact** rule for the
one command or path you tapped on (`Bash:npm test`, `Write:/path`,
`WebFetch:https://…`): a trailing `*` is stored escaped as `\*`, so one tap on
`git add *` never turns into "anything starting with `git add`". Prefix rules
(`Bash:git status*`) are yours to write in Settings; they are honoured for
reads, writes, commands and web calls, but they never override the
destructive-command check — only an exact rule for the full command does.
Deny rules beat allow rules, and they hold in every mode, Auto included, and
for Genie's own tools: the live driver enforces them through a `PreToolUse`
hook, the one gate the SDK consults even when it is bypassing permissions.
Rules live in Settings, each listed as exact, prefix or any and as allow or
deny; the form beneath the list adds one and ✕ removes one.

What counts as **destructive** (and therefore asks even in Trust): `rm -rf` on
`/`, `~`, `*`, `.`, `.git` or a shallow path; `sudo`/`su`; `mkfs`, `dd if=`,
writes to `/dev/sd*`; `shutdown`/`reboot`; `chmod -R 777 /`; `git push --force`,
`git reset --hard`, `git clean -fd`, `git branch -D`; `curl … | sh`;
fork bombs; `kill -9 -1`, `killall`; `DROP TABLE`, `TRUNCATE`, `DELETE FROM`
without a `WHERE`; `crontab -r`; writes into `~/.ssh`, `/etc/`, shell rc files;
`npm publish`, `docker system prune`, `terraform destroy`, `kubectl delete`;
and anything that looks like key exfiltration. Everyday commands (`git status`,
`npm test`, `rm -rf node_modules`, `rm file.txt`) are not flagged.

## What it can do

- **Tools** — the Claude Code set: `Bash`, `Read`, `Write`, `Edit`, `Glob`,
  `Grep`, `WebSearch`, `WebFetch`, `Task` (subagents), `TodoWrite` and MCP.
  Each call shows as a live card: icon, one-line summary, elapsed time,
  collapsible output, running / done / error.
- **Courtiers** — three subagents defined through the SDK's `agents` option:
  **researcher** (finds and reads: web, files, docs — never writes; `Read`,
  `Glob`, `Grep`, `WebSearch`, `WebFetch` on `claude-sonnet-5`), **coder**
  (implements a scoped change and runs its tests; inherits tools and model)
  and **reviewer** (adversarial reviewer: tries to break the work before it
  ships; `Read`, `Glob`, `Grep`, `Bash`). Their tool cards nest inside the
  `Task` card that spawned them.
- **Genie's own tools** — an in-process MCP server the model can call:
  `remember`, `forget`, `schedule`, `unschedule`, `list_schedules`, `notify`.
  So *"remember that staging deploys from the release branch"* becomes a
  memory entry, *"every morning check the build"* becomes a standing order,
  and a long job can ping your phone when it finishes.
- **Memory** — `~/.genie/MEMORY.md`, one bullet per fact (`- [YYYY-MM-DD]
  fact`), at most 200 entries, read into every system prompt. Edit it from the
  drawer, with `/remember` and `/forget`, or let the model file things itself.
- **Standing orders** — schedules with a cron-grade, clock-injected grammar,
  each firing into its own `⏰` conversation: `every 30m`, `every 2 hours`,
  `hourly`, `every day at 09:00`, `daily at 6pm`, `every morning`, `weekdays at
  08:30`, `weekends at 10`, `every mon,wed,fri at 07:00`, `on tuesdays at 9`,
  `at 22:00`, or `cron 0 9 * * 1-5` (lists, ranges, steps, month and day
  names; a Quartz-style `?` in a day field is a wildcard). Minimum interval
  60 s. The scheduler polls every 20 s, and an `every` order re-arms from the
  time it was due, not from the tick that noticed it, so a late tick never
  compounds into drift (one missed by more than a period restarts from now).
- **Custom commands** — drop `~/.genie/commands/<name>.md` (optional first line
  `# description`, then a prompt template with `$ARGUMENTS`, `$1`…`$9`) and
  `/name args` runs it. They show up in the composer's `/` autocomplete.
- **Models** — `claude-opus-5` (default, the best all-rounder), `claude-fable-5-1`
  (most capable), `claude-sonnet-5` (fast), `claude-haiku-4-5` (cheapest).
  Effort `low`…`max` (default `high`). Per-run ceilings: 200 turns, $20.

## Slash commands

| Command | What it does |
|---|---|
| `/help` | what Genie can do and how to talk to it |
| `/new` | start a fresh conversation |
| `/stop` | stop the run in this conversation |
| `/status` | driver, model, mode, cwd, spend so far (this conversation and all of them) |
| `/mode <ask\|trust\|auto>` | how much Genie asks before acting |
| `/model <id>` | switch the model |
| `/effort <level>` | `low` · `medium` · `high` · `xhigh` · `max` |
| `/cwd <path>` | change the working directory |
| `/remember <fact>` | add a durable fact to memory |
| `/forget <n\|all>` | remove memory entry *n* (or all) |
| `/memory` | show what Genie remembers |
| `/schedule <when> <task>` | add a standing order (`every 30m` · `daily at 09:00` · `cron …`) |
| `/schedules` | list standing orders |
| `/unschedule <id>` | remove a standing order |
| `/run <id>` | run a standing order now |
| `/commands` | list custom commands |

Built-ins are answered by the server without spending a token; an unknown
`/name` runs the matching custom command, or replies *unknown command — try
/help*.

## The API

JSON over HTTP; every route but `/api/health` and the static console needs
`Authorization: Bearer <key>` (or `?key=`). Failure → `401 {"error":"unauthorized"}`.

| Route | Purpose |
|---|---|
| `GET /api/health` | `{ ok, name:'genie', version, needsKey }` — unauthenticated |
| `GET /api/status` | driver, model, mode, effort, cwd, busy, queue, memory/schedule counts, sdk, credentials, `rootUnsandboxed` + `autoBlockedReason` |
| `GET` / `PATCH /api/settings` | mode, model, effort, cwd (must exist), owner, maxTurns, maxUsd, rules — or `addRule` / `removeRule` `{ tool, match, behavior }` to edit one rule by content, so two consoles never overwrite each other |
| `GET` / `POST /api/conversations`, `GET` / `DELETE /api/conversations/:id` | list · create · transcript · delete (409 while running) |
| `POST /api/conversations/:id/say` `{ text, tz? }` | a prompt → `{ runId, queued }`; a slash command → `{ handled, reply }` |
| `GET /api/conversations/:id/events?since=<seq>` | NDJSON: stored + live events, then stays open (`ping` every 15 s) |
| `POST /api/approve` `{ requestId, decision:'allow'\|'deny'\|'always', answers? }` | answer an approval — or a question, with `answers: { [question]: text }` |
| `POST /api/stop` `{ conversationId }` | abort the active run, drop queued ones |
| `GET` / `POST /api/memory`, `DELETE /api/memory/:n` | the memory file |
| `GET` / `POST /api/schedules`, `PATCH` / `DELETE /api/schedules/:id`, `POST /api/schedules/:id/run` | standing orders |
| `GET /api/commands` | custom commands |

One run at a time, globally; others queue FIFO. The event stream is Genie's
own language, reduced from SDK messages by the engine: `run_start`, `user`,
`init`, `thinking`, `text` (streamed delta), `text_final` (canonical block —
replaces the streamed bubble), `tool`, `tool_result`, `progress`, `status`,
`ask` / `ask_resolved`, `notify`, `system`, `result`, `error`, `run_end`,
`ping`. An `ask` is `kind:'permission'` (Allow / Always allow / Deny) or
`kind:'question'` (the agent's `questions`, each with `header`, `options` and
`multiSelect`), and a question's `ask_resolved` carries the `answers`. Each
event carries a per-conversation `seq`, so a client that reconnects with
`?since=` never misses or duplicates one. Only durable events are written to
disk (never `text`, `thinking`, `progress` or `ping`), and a `tool` event
stores a clipped copy of its input — the SDK gets the whole file, the
transcript does not. A run cut off by a hard crash (SIGKILL, OOM, power) is
closed at the next boot the way a stop would close it — its open ask resolved
`deny` by `stop`, then an `error` and a `run_end {status:'stopped'}` — so the
console never replays a live card nobody can answer.

## Safety posture

What the code actually enforces — and what it doesn't:

- **Bash, Edit and Write reach anything the process user can reach.** `cwd`
  is where a run starts, not a sandbox; the system prompt asks the agent to
  work there, but an instruction is not a boundary. A Genie on your laptop
  has your laptop's powers. Run jobs you don't fully trust in a container.
- **Modes are a gate on the SDK's `canUseTool`, not a policy language.** Ask
  and Trust hold the tool call until you answer (or until
  `GENIE_ASK_TIMEOUT_MS` — ten minutes — expires and it is denied). **Auto
  never asks for permission**: it passes `bypassPermissions` and
  `allowDangerouslySkipPermissions` to the SDK, and the console makes you
  confirm before switching to it. The one thing that still reaches your phone
  in Auto is a *question* the agent asks you — that is not a permission, and
  no mode or rule answers it on your behalf. Live Auto also needs a non-root
  user or `IS_SANDBOX=1`: the CLI refuses it for root outside a sandbox, and
  Genie refuses the switch rather than let every run fail.
- **Rules are matches on a command or path, and only "Always allow" is
  guaranteed exact.** What you tap becomes one exact rule (a trailing `*`
  escaped, never a prefix). Prefix rules are user-authored, and never talk
  the destructive-command check out of asking. Deny rules are enforced in
  every mode — the live driver runs them as a `PreToolUse` hook, which the SDK
  consults even when it bypasses permissions — and Genie's own tools are not
  exempt. Good for `npm test`; not a substitute for thinking.
- **The destructive-command classifier is a pattern list.** It catches the
  classic footguns (it is unit-tested against a table of them) and it is
  case- and chaining-aware, but an obfuscated command walks past it. Treat it
  as a seat belt, not a cage; Ask mode is the cage.
- **Web content is untrusted input to an agent that can run commands.**
  `WebFetch`/`WebSearch` are gated in Ask mode and free in Trust. A page can
  try to talk the model into something; the approval cards are where you
  notice. Tool output is stripped of ANSI/control characters before it
  reaches the console, and markdown is escaped before it is decorated, so a
  fetched page can't rewrite the transcript or inject a script.
- **The key is the only lock**, and it travels as a bearer token over plain
  HTTP. Loopback by default; `HOST=0.0.0.0` prints a loud warning. On
  anything but a trusted LAN put TLS in front of it (a reverse proxy or a
  tunnel). `GENIE_ALLOW_ORIGIN` adds CORS headers for a comma-separated list
  of exact origins (or `*`) — the matching origin is echoed back, nothing is
  echoed for a stranger — and is off unless you set it.
- **Budgets are per run, enforced by the SDK** (`maxTurns`, `maxBudgetUsd`).
  They are not per day: a standing order runs unattended while you sleep, and
  every firing is a fresh budget. Check the cost meter and the conversation
  list; `/status` shows the spend so far, for the conversation and across all
  of them.
- **Standing orders fire whether or not you're watching**, into their own
  conversation, under the current mode. In Ask mode an unattended run will
  simply time out at its first gated tool — Trust is what makes schedules
  useful, so choose the tasks accordingly. A question the agent asks waits for
  you too, in any mode, until `GENIE_ASK_TIMEOUT_MS` declines it.
- **Timeouts are clamped to what a Node timer can hold** (2³¹−1 ms, about
  24.8 days): a larger `GENIE_ASK_TIMEOUT_MS` or `GENIE_SCHEDULER_MS` would
  otherwise fire after one millisecond, which for the ask timeout means
  "deny everything at once".
- **State on disk is plain files** under `GENIE_HOME` (`key`, `settings.json`,
  `MEMORY.md`, `schedules.json`, `conversations/*.json`, `commands/*.md`).
  Transcripts include tool output — the same thing you saw on screen — and a
  clipped copy of tool inputs. Writes are atomic (temp file + rename) so a
  crash can't half-write them, and a run the crash cut off is closed at the
  next boot (see the API notes) rather than left open on disk.
- **Rehearsal never spends money and never runs anything.** It is a pure,
  network-free script that replays the shape of a run and labels itself.

## Deploying

Genie is meant to live where your files are — a laptop, a home server, a VPS.
It has no dependencies beyond the Agent SDK and nothing to build.

**VPS / container.** Persist `GENIE_HOME`, set the key, bind all interfaces,
and put TLS in front:

```bash
docker run -d --name genie -p 8800:8800 \
  -v genie-home:/data -v "$PWD":/app -w /app \
  -e GENIE_HOME=/data -e HOST=0.0.0.0 -e GENIE_KEY=<32 hex chars> \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e IS_SANDBOX=1 \
  node:22-alpine sh -c "npm ci --omit=dev && node genie/server.mjs"
```

`IS_SANDBOX=1` is there for Auto: the process in that image is root, and the
Claude Code CLI refuses `bypassPermissions` for root unless the environment
declares itself a sandbox — without it Auto is refused at the switch, Ask and
Trust work as usual. Setting it says "I accept this container as
disposable", which for a container is the truth. The stricter alternative is
a non-root user (`--user node`), in which case give that user a `GENIE_HOME`
it can write (a bind mount it owns, or `chown -R 1000` the volume once).

The container is also the honest answer to "what can it break": everything
inside it, nothing outside it.

**Render.** `render.yaml` at the repo root declares a `genie` web service
(free plan, `node genie/server.mjs`, health check on `/api/health`,
`HOST=0.0.0.0`, `GENIE_MODE=trust`, a generated `GENIE_KEY`, an
`ANTHROPIC_API_KEY` you paste in the dashboard, and `GENIE_ALLOW_ORIGIN` set to
both origins the hosted console can be served from). Deploy it as a Blueprint,
read `GENIE_KEY` from the Environment tab, and open
`https://<service>.onrender.com/?key=<GENIE_KEY>` on your phone. **The free
disk is ephemeral**: memory, conversations and standing orders are wiped on
every deploy and restart (the key survives because it is an env var). For
state that must last, use a paid instance with a disk and point `GENIE_HOME`
at its mount. If the boot log warns that the service runs as root outside a
sandbox, add `IS_SANDBOX=1` to its environment before reaching for Auto.

**The hosted console.** The copy published from this repo is the console only —
no server behind it. GitHub Pages serves the site from its custom domain, so
the page you actually load is <https://apexvip.uk/genie/>; the
<https://refayethossain28.github.io/BallrzAPP/genie/> address redirects there.
Its Connect screen takes a server URL and key, so it can drive a Genie you run
anywhere, provided that server sends CORS headers for the page's origin —
list both, and the config keeps working whichever host serves the page:

```bash
GENIE_ALLOW_ORIGIN=https://apexvip.uk,https://refayethossain28.github.io
```

Without a server it shows the run command and stops there.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8800` | listen port |
| `HOST` | `127.0.0.1` | bind address; anything but loopback warns loudly |
| `GENIE_HOME` | `~/.genie` | key, settings, memory, schedules, conversations, commands, workspace |
| `GENIE_KEY` | read/created at `GENIE_HOME/key` | the bearer key the console needs |
| `GENIE_MODEL` | `claude-opus-5` | model |
| `GENIE_MODE` | `trust` | `ask` · `trust` · `auto` |
| `GENIE_EFFORT` | `high` | `low` · `medium` · `high` · `xhigh` · `max` |
| `GENIE_CWD` | `GENIE_HOME/workspace` (created) | where runs start |
| `GENIE_OWNER` | `you` | how the system prompt names you |
| `GENIE_MAX_TURNS` | `200` | per-run turn ceiling (1–1000) |
| `GENIE_MAX_USD` | `20` | per-run spend ceiling (0.1–1000) |
| `GENIE_DRIVER` | `auto` | `auto` · `live` · `rehearsal` |
| `GENIE_ALLOW_ORIGIN` | unset (no CORS) | comma-separated exact origins, or `*`; the matching one is echoed |
| `GENIE_ASK_TIMEOUT_MS` | `600000` | unanswered approvals (and questions) resolve to deny; clamped to 1 s … 2³¹−1 ms |
| `GENIE_SETTING_SOURCES` | none | comma list passed to the SDK's `settingSources` |
| `GENIE_SCHEDULER_MS` | `20000` | how often standing orders are checked; clamped to 250 ms … 2³¹−1 ms |
| `IS_SANDBOX` | unset | `1` tells the Claude Code CLI a root process is inside a disposable sandbox, which live Auto needs when running as root |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` | — | credentials (or `~/.claude/.credentials.json`) |

Settings changed from the console (`PATCH /api/settings`) are saved to
`GENIE_HOME/settings.json`. At boot the file is loaded first and any
`GENIE_*` env var set is applied on top — an env var is explicit operator
intent at launch, so it wins over the file.

## Tests

```bash
npm run test:genie          # scripts/test-genie-logic.mjs — the engine, in a vm sandbox with a fixed clock
npm run test:genie-server   # scripts/test-genie-server.mjs — boots the real server in rehearsal mode
npm run test:smoke          # every prototype's inline script, including this console
npm run icons:genie         # regenerate icon-180/192/512.png from the lamp motif
```

The engine tests cover the markdown renderer's XSS canaries, the schedule
grammar and next-run walker across midnight and month/year edges (cron `?`
included), the danger table, `decide` across every mode and rule shape (exact
vs prefix vs escaped `\*`, danger vs allow rules, questions in every mode),
the SDK-message reducer over a scripted run (subagents included), memory,
cost, the system prompt and the rehearsal script. The server tests spawn
`server.mjs` twice (Ask on 8801 with two CORS origins, Auto on 8802): auth,
CORS on the API and on the stream, static allowlist and traversal, a full run
through the NDJSON stream with approve / deny / always / timeout, the
exact-rule guarantee and rule precedence through the settings API, a question
answered and declined from the phone in Ask and in Auto, slash commands
(`/status` with its spend figure), schedules firing — a due `every` order
re-arming from its due time, run-now, a Saturday-only cron `?` — stop,
409/413/400, a restart on 8803 that proves conversations and memory persist,
and a run cut off by a hard crash being closed at that boot. Both are part of
root `npm test`.

## Architecture (house rules)

- `engine.js` — every rule: text safety and markdown, slash commands, the
  schedule grammar, the permission policy and danger table, the SDK → event
  reducer, cost, memory, the system prompt, validation, rehearsal. Pure,
  deterministic, clock-injected; a classic script that loads in the browser,
  in `node:vm` and via `module.exports`.
- `agent.mjs` — the driver: live (Agent SDK) and rehearsal (offline). Never
  throws into the server; retries once without `resume` when a session is
  gone; enforces deny rules through a `PreToolUse` hook and hands a
  question's answers back to the tool as `updatedInput.answers`.
- `server.mjs` — `node:http` console server: static allowlist, JSON/NDJSON
  API with CORS for a list of origins, one-at-a-time run queue, approvals and
  question cards, scheduler, atomic persistence, crash reconciliation at boot.
- `index.html` — the console, one smoke-test-clean file. `manifest.json` +
  `sw.js` make it an installable PWA with an offline shell (network-first
  navigations, cache-first assets, `/api/` never cached).
