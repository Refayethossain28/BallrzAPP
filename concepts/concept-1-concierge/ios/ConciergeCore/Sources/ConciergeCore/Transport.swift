import Foundation

/// The messaging-core boundary. In production this is the Signal-protocol
/// double-ratchet over an encrypted relay — the relay never sees plaintext.
/// Keeping it behind a protocol is the point: the app talks to `MessageTransport`,
/// and the E2EE implementation is swapped in without the UI knowing.
public protocol MessageTransport {
    func send(_ message: Message, in conversation: UUID) async throws
    /// Inbound messages from other participants.
    var incoming: AsyncStream<Message> { get }
}

/// In-memory loopback transport for the slice — no network, no crypto. It exists
/// to prove the seam: the app is written against `MessageTransport`, so dropping
/// in a real encrypted transport later is a one-line change at composition time.
public final class LocalTransport: MessageTransport {
    public let incoming: AsyncStream<Message>
    private let continuation: AsyncStream<Message>.Continuation

    public init() {
        var captured: AsyncStream<Message>.Continuation!
        incoming = AsyncStream { captured = $0 }
        continuation = captured
    }

    public func send(_ message: Message, in conversation: UUID) async throws {
        // Loopback delivery. A real transport would encrypt, relay, and decrypt.
        continuation.yield(message)
    }
}
