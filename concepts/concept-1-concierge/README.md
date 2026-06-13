# Concept 1 — Native slice (iOS)

The first real build slice of the [AI Life Concierge](../01-ai-life-concierge.md):
a SwiftUI messaging thread with the **split-the-bill agent action** wired through
the architecture's load-bearing boundaries. This is build-order steps 1–2 from
the doc (1:1 messaging + the first viral agent action), structured so the hard
parts (E2EE transport, the LLM) sit behind protocols you can swap.

> **Status — not compiler-verified here.** This was written in an environment
> without a Swift toolchain, so it has **not** been built or run. It's idiomatic
> SwiftUI/SPM intended to open in Xcode 15+. The pure logic mirrors the
> already-verified web prototype (`../prototypes/concierge-split`), whose penny
> math and idempotency were checked in Node — but treat the Swift as a
> first-pass scaffold to compile and tighten, not finished code.

## Layout

```
ios/
├── ConciergeCore/                 ← SPM package: the verifiable kernel (no UI, no keys)
│   ├── Package.swift              ← `swift test` runs the suite below
│   ├── Sources/ConciergeCore/
│   │   ├── Models.swift           ← Message, SplitProposal, SplitMath (deterministic cents)
│   │   ├── Agent.swift            ← AgentService protocol, StubAgent, ClaudeAgent, SplitLedger
│   │   └── Transport.swift        ← MessageTransport protocol + LocalTransport (E2EE seam)
│   └── Tests/ConciergeCoreTests/
│       └── SplitTests.swift       ← penny-sum, remainder, idempotency, parse cases
└── ConciergeApp/                  ← SwiftUI app (open in Xcode; depends on ConciergeCore)
    ├── ConciergeApp.swift         ← @main
    ├── ConversationStore.swift    ← view-model: thread + agent + ledger
    └── Views.swift                ← ConversationView, MessageBubble, SplitProposalCard
```

## The three architecture boundaries made real

Straight from [Part B of the concept doc](../01-ai-life-concierge.md#part-b--architecture-sketch):

1. **Messaging core stays dumb and encrypted** → `MessageTransport`. The app is
   written against this protocol; the slice ships a `LocalTransport` loopback,
   and the production Signal-protocol/E2EE transport drops in without the UI
   knowing. The seam is the deliverable.
2. **The agent is opt-in and the tool layer is the product** → `AgentService`.
   The model only does the natural-language parse (who + how much); the dollar
   math lives in `SplitMath` in trusted code and is **never** delegated to the
   LLM. `StubAgent` runs offline; `ClaudeAgent` calls a backend.
3. **Idempotent execution + human confirm** → `SplitLedger` + the card's
   Confirm button. The agent *proposes*; a human *commits*; re-confirming the
   same proposal is a guaranteed no-op (the key guards it).

## What's real vs stubbed

| Piece | This slice | Production |
|-------|-----------|------------|
| Messaging transport | in-memory loopback | Signal double-ratchet over an encrypted relay |
| Bill parsing | deterministic `StubAgent`, or `ClaudeAgent` → backend | `ClaudeAgent` → your agent service |
| Money math | `SplitMath` (exact cents, on-device) | same — trusted code, both ends |
| Idempotency | in-memory `SplitLedger` | durable ledger keyed by idempotency key |
| Payment request | a system line in the thread | real rails (Apple Pay / card / bank) |

## Run it

**Test the kernel** (the part that's meant to be verifiable):

```sh
cd concepts/concept-1-concierge/ios/ConciergeCore
swift test
```

**Run the app:** open `ios/` in Xcode, add `ConciergeCore` as a local package
dependency of an iOS App target containing the `ConciergeApp/` files, and run.

**Wire live Claude:** start the proxy from the web prototype and point the agent
at it — one line in `ConversationStore.init`:

```swift
// from: ConversationStore(agent: StubAgent())
ConversationStore(agent: ClaudeAgent(endpoint: URL(string: "http://localhost:8787/agent")!))
```

```sh
cd ../../prototypes/concierge-split
ANTHROPIC_API_KEY=sk-ant-... node server.mjs   # forced parse_bill tool call
```

`ClaudeAgent` posts the message to the proxy, the proxy makes the forced
`parse_bill` tool call against `claude-opus-4-8`, and the parse comes back —
then `SplitMath` recomputes the cents locally so amounts are trusted on both
sides.

## Next steps (in order)

1. Compile in Xcode and fix the inevitable first-pass issues.
2. Real transport: implement `MessageTransport` over an encrypted relay so two
   devices can actually message (this is the genuinely hard part — see the
   doc's "what would kill it").
3. Second viral action: **live translate**, proving the agent pattern
   generalizes past split-the-bill.
