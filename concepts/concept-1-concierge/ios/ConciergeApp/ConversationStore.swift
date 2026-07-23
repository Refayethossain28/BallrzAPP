import Foundation
import ConciergeCore

/// View-model wiring the thread to the agent and the idempotent ledger.
/// Swap `StubAgent()` for `ClaudeAgent(endpoint:)` to use live Claude tool-use.
@MainActor
final class ConversationStore: ObservableObject {

    /// One row in the thread: a chat message, a system line, or an agent card.
    enum Item: Identifiable {
        case message(Message)
        case system(id: UUID, text: String)
        case proposal(SplitProposal)

        var id: UUID {
            switch self {
            case .message(let m): return m.id
            case .system(let id, _): return id
            case .proposal(let p): return p.id
            }
        }
    }

    @Published private(set) var items: [Item] = []
    @Published private(set) var confirmedKeys: Set<String> = []

    let roster = ["you", "Sam", "Alex"]
    private let agent: AgentService
    private let ledger = SplitLedger()

    init(agent: AgentService = StubAgent()) {
        self.agent = agent
        seed()
    }

    private func seed() {
        items = [
            .system(id: UUID(), text: "Today"),
            .message(Message(sender: "Sam", text: "that sushi place was unreal 🍣")),
            .message(Message(sender: "Alex", text: "who paid? i owe you")),
        ]
    }

    /// Send a user message; the agent reads it and, if it finds a bill, posts a
    /// proposal card. Implicit invocation — no explicit @assistant needed.
    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        items.append(.message(Message(sender: "you", text: trimmed)))

        Task {
            do {
                if let proposal = try await agent.proposeSplit(from: trimmed, roster: roster) {
                    items.append(.proposal(proposal))
                } else {
                    items.append(.system(id: UUID(), text: "(no actionable bill — the agent stays quiet)"))
                }
            } catch {
                items.append(.system(id: UUID(), text: "(agent unreachable — try again)"))
            }
        }
    }

    func isConfirmed(_ proposal: SplitProposal) -> Bool {
        confirmedKeys.contains(proposal.idempotencyKey)
    }

    /// Human-in-the-loop commit. Idempotent: re-confirming the same proposal is
    /// a guaranteed no-op, so money never moves twice.
    func confirm(_ proposal: SplitProposal) {
        let isNew = ledger.execute(proposal)
        confirmedKeys.insert(proposal.idempotencyKey)
        guard isNew else {
            items.append(.system(id: UUID(), text: "⚠︎ This split was already sent — skipped (idempotency key matched)."))
            return
        }
        // Emit a payment request per debtor, visible to the whole group.
        for share in proposal.debtors {
            let amount = String(format: "%.2f", share.dollars)
            items.append(.system(id: UUID(), text: "💸 Requested $\(amount) from \(share.name)"))
        }
    }
}
