# The App Suite

Thirteen self-contained demo apps, one per category of "best apps to build."
Every app is dependency-free vanilla HTML/CSS/JS (or zero-dependency Node for the
CLI) — no build step, no package installs, works offline.

Start at [`index.html`](index.html) for the full showcase.

## Web apps

| App | Folder | What it is |
|---|---|---|
| **Pulse** | `pulse-dashboard/` | Analytics dashboard — KPI tiles, SVG line/bar charts, sortable order table |
| **Slotwise** | `slotwise-booking/` | Booking & scheduling — month calendar, time slots, cancellations |
| **Bazaar** | `bazaar-marketplace/` | Marketplace — listings, filters, favourites, sell form, seller chat |
| **LaunchKit** | `launchkit-saas/` | SaaS starter — landing + pricing, mock auth, dashboard, settings |
| **Ledgerly** | `ledgerly-invoices/` | Invoice generator — line items, tax/discount, saved invoices, print view |
| **Atlas** | `atlas-dataviz/` | Data explorer — linked scatter plot + table over a world-cities dataset |

## AI-powered

These work fully offline via built-in local engines (extractive retrieval,
heuristic summarization, deterministic agent simulation). Pasting an Anthropic
API key in each app's settings upgrades responses to live Claude output —
keys live in browser localStorage, demo use only.

| App | Folder | What it is |
|---|---|---|
| **DocChat** | `docchat-rag/` | Ask-your-documents RAG chat with citation cards |
| **Quill** | `quill-ai-writer/` | Summarizer, email drafter, product copy, tone rewriter |
| **Relay** | `relay-agent/` | Visible agent loop: goal → plan → tool calls → report |

## Games & mobile

| App | Folder | What it is |
|---|---|---|
| **Gridlock** | `gridlock-game/` | 2048-style sliding puzzle — animations, undo, touch, best score |
| **HabitLoop** | `habitloop-pwa/` | Installable offline habit tracker — streaks, 12-week heatmap |

## Developer tools

| App | Folder | How to run |
|---|---|---|
| **NoteMark** | `notemark-extension/` | Chrome MV3 page annotator — `chrome://extensions` → Load unpacked |
| **Forge** | `forge-cli/` | `node apps/forge-cli/forge.mjs --help` — dir stats, HTML reports, TODO hunter |

## Serving

Any static server works, e.g.:

```sh
python3 -m http.server -d apps 8080
# or
npx serve apps
```

Opening `index.html` straight from disk also works for everything except
service-worker installation in HabitLoop (browsers require http/https for that).
