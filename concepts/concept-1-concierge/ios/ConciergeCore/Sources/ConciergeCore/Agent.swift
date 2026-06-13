import Foundation

/// The agent abstraction. Its only job in this slice is to turn a free-text
/// message into a structured `SplitProposal`, or nil when there's nothing to
/// act on. Two implementations: a deterministic on-device stub, and one that
/// calls Claude through a backend (the API key never lives on the client).
public protocol AgentService {
    func proposeSplit(from text: String, roster: [String]) async throws -> SplitProposal?
}

/// Idempotent execution ledger. Confirming the same proposal twice — a retried
/// tap, a duplicated network event — must never charge anyone twice. The key
/// is the guard.
public final class SplitLedger {
    private var executed = Set<String>()
    public init() {}

    /// Returns true if this proposal was executed now; false if its key already
    /// ran (in which case the caller must treat it as a no-op).
    @discardableResult
    public func execute(_ proposal: SplitProposal) -> Bool {
        if executed.contains(proposal.idempotencyKey) { return false }
        executed.insert(proposal.idempotencyKey)
        return true
    }

    public func wasExecuted(_ proposal: SplitProposal) -> Bool {
        executed.contains(proposal.idempotencyKey)
    }
}

/// On-device deterministic parser standing in for the LLM. Mirrors the web
/// prototype's stub so the app works fully offline.
public struct StubAgent: AgentService {
    public init() {}

    public func proposeSplit(from text: String, roster: [String]) async throws -> SplitProposal? {
        guard let total = Self.firstAmount(in: text) else { return nil }
        let lower = text.lowercased()

        var people: [String] = []
        if lower.range(of: #"\b(me|i|us)\b"#, options: .regularExpression) != nil {
            people.append("you")
        }
        for participant in roster where participant != "you" {
            if lower.contains(participant.lowercased()) { people.append(participant) }
        }
        if people.count < 2,
           lower.range(of: #"every(one|body)|group|all of us"#, options: .regularExpression) != nil {
            people = roster
        }
        return SplitMath.evenSplit(totalDollars: total, participants: people)
    }

    static func firstAmount(in text: String) -> Double? {
        let cleaned = text.replacingOccurrences(of: ",", with: "")
        guard let range = cleaned.range(of: #"\$?\s*\d+(\.\d{1,2})?"#, options: .regularExpression) else {
            return nil
        }
        let token = cleaned[range]
            .replacingOccurrences(of: "$", with: "")
            .trimmingCharacters(in: .whitespaces)
        return Double(token)
    }
}

/// Calls Claude through a backend proxy (e.g. the `server.mjs` in
/// ../../prototypes/concierge-split) which holds the API key and makes the
/// forced `parse_bill` tool call. The proxy returns the parse; this client
/// re-runs the money math locally via `SplitMath`, so amounts are computed in
/// trusted code on both ends.
public struct ClaudeAgent: AgentService {
    public let endpoint: URL
    public let session: URLSession

    public init(endpoint: URL, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    private struct Envelope: Decodable {
        struct Proposal: Decodable {
            struct Share: Decodable { let name: String }
            let total: Double
            let shares: [Share]
        }
        let ok: Bool
        let proposal: Proposal?
    }

    public func proposeSplit(from text: String, roster: [String]) async throws -> SplitProposal? {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text, "roster": roster])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard envelope.ok, let proposal = envelope.proposal else { return nil }
        let names = proposal.shares.map(\.name)
        return SplitMath.evenSplit(totalDollars: proposal.total, participants: names)
    }
}
