import Foundation

/// A chat message. `sender` is a participant id ("you", "Sam", "Alex").
/// In production the message body travels the encrypted transport; the relay
/// never sees this struct in plaintext (see `MessageTransport`).
public struct Message: Identifiable, Codable, Equatable, Sendable {
    public let id: UUID
    public let sender: String
    public let text: String
    public let sentAt: Date

    public init(id: UUID = UUID(), sender: String, text: String, sentAt: Date = Date()) {
        self.id = id
        self.sender = sender
        self.text = text
        self.sentAt = sentAt
    }

    public var isMe: Bool { sender == "you" }
}

/// A proposed bill split. The agent *proposes* this; a human *confirms* it;
/// the `idempotencyKey` makes confirming the same proposal twice a no-op.
public struct SplitProposal: Identifiable, Codable, Equatable {
    public struct Share: Codable, Equatable, Identifiable {
        public var id: String { name }
        public let name: String
        public let cents: Int
        public init(name: String, cents: Int) { self.name = name; self.cents = cents }
        public var dollars: Double { Double(cents) / 100 }
    }

    public let id: UUID
    public let totalCents: Int
    public let payer: String
    public let shares: [Share]
    public let idempotencyKey: String

    public init(id: UUID = UUID(), totalCents: Int, payer: String, shares: [Share], idempotencyKey: String) {
        self.id = id
        self.totalCents = totalCents
        self.payer = payer
        self.shares = shares
        self.idempotencyKey = idempotencyKey
    }

    public var totalDollars: Double { Double(totalCents) / 100 }

    /// Everyone who owes the payer (i.e. excludes the payer's own share).
    public var debtors: [Share] { shares.filter { $0.name != payer } }
}

/// Deterministic money math — kept in trusted code, never delegated to the LLM.
/// The agent extracts *who* and *how much*; this turns that into exact cents.
public enum SplitMath {
    /// Even split with leftover pennies pushed to the payer's share, so the
    /// per-person amounts always sum back to the bill exactly. Returns nil when
    /// there isn't enough to act on (no positive total, or fewer than 2 people).
    public static func evenSplit(totalDollars: Double,
                                 participants: [String],
                                 payer: String = "you") -> SplitProposal? {
        // de-dupe, preserving order, so the payer stays at index 0
        var uniq: [String] = []
        for p in participants where !uniq.contains(p) { uniq.append(p) }
        guard totalDollars > 0, uniq.count >= 2 else { return nil }

        let cents = Int((totalDollars * 100).rounded())
        let base = cents / uniq.count
        let remainder = cents - base * uniq.count
        let shares = uniq.enumerated().map { index, name in
            SplitProposal.Share(name: name, cents: base + (index < remainder ? 1 : 0))
        }
        // Stable key from the normalized intent: same people + same total => same key.
        let key = "split_" + uniq.sorted().joined(separator: "-") + "_\(cents)"
        return SplitProposal(totalCents: cents, payer: payer, shares: shares, idempotencyKey: key)
    }
}
