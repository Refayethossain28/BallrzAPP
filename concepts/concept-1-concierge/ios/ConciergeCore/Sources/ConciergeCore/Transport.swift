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

// MARK: - End-to-end encrypted relay transport

/// The encryption boundary. Plaintext crosses this on the device only; the relay
/// sees nothing but what `seal` produces. The production implementation is a
/// Signal-style double ratchet (per-conversation forward-secret keys); the app
/// and the relay are written against this protocol so that swap is invisible to both.
public protocol MessageCipher: Sendable {
    func seal(_ plaintext: Data) throws -> Data
    func open(_ ciphertext: Data) throws -> Data
}

/// Dev/test cipher: no encryption. Useful for wiring the transport before the
/// ratchet exists.
public struct PlaintextCipher: MessageCipher {
    public init() {}
    public func seal(_ plaintext: Data) throws -> Data { plaintext }
    public func open(_ ciphertext: Data) throws -> Data { ciphertext }
}

/// ⚠️ NOT secure — a stand-in that merely proves the boundary (the relay sees only
/// transformed bytes, never plaintext). Replace with the real double ratchet.
public struct RotatingXORCipher: MessageCipher {
    private let key: [UInt8]
    public init(key: String) {
        let bytes = Array(key.utf8)
        precondition(!bytes.isEmpty, "key must be non-empty")
        self.key = bytes
    }
    private func transform(_ data: Data) -> Data {
        var out = Data(count: data.count)
        for i in 0..<data.count { out[i] = data[i] ^ key[i % key.count] }
        return out
    }
    public func seal(_ plaintext: Data) throws -> Data { transform(plaintext) }
    public func open(_ ciphertext: Data) throws -> Data { transform(ciphertext) }
}

/// A sealed message as it travels the wire: routing metadata in the clear,
/// payload encrypted. This is *all* the relay ever holds.
public struct SealedEnvelope: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let conversation: UUID
    public let sender: String          // sending *device* id, for fan-out routing
    public let ciphertext: Data
    public let sentAt: Date

    public init(id: UUID = UUID(), conversation: UUID, sender: String, ciphertext: Data, sentAt: Date) {
        self.id = id; self.conversation = conversation; self.sender = sender
        self.ciphertext = ciphertext; self.sentAt = sentAt
    }
}

/// The untrusted relay: it fans sealed envelopes out to the other devices and
/// never decrypts. In production this is a thin server (or a P2P mesh); the
/// contract is the same — ciphertext in, ciphertext out.
public protocol MessageRelay: AnyObject {
    func publish(_ envelope: SealedEnvelope)
    func subscribe(_ deviceID: String) -> AsyncStream<SealedEnvelope>
}

/// In-process relay for tests and the local two-party slice. Delivers each
/// envelope to every subscribed device except the original sender.
public final class InProcessRelay: MessageRelay, @unchecked Sendable {
    private var subscribers: [String: AsyncStream<SealedEnvelope>.Continuation] = [:]
    /// Everything the relay has handled — ciphertext only. Tests assert against this.
    public private(set) var log: [SealedEnvelope] = []

    public init() {}

    public func subscribe(_ deviceID: String) -> AsyncStream<SealedEnvelope> {
        AsyncStream { continuation in
            self.subscribers[deviceID] = continuation
        }
    }

    public func publish(_ envelope: SealedEnvelope) {
        log.append(envelope)
        for (device, continuation) in subscribers where device != envelope.sender {
            continuation.yield(envelope)
        }
    }
}

/// A `MessageTransport` that encrypts on the way out and decrypts on the way in,
/// so the relay only ever moves `SealedEnvelope`s. This is the piece the app
/// composes against in production.
public final class RelayTransport: MessageTransport, @unchecked Sendable {
    public let deviceID: String
    private let relay: MessageRelay
    private let cipher: MessageCipher

    public let incoming: AsyncStream<Message>
    private let inbound: AsyncStream<Message>.Continuation
    private var pump: Task<Void, Never>?

    public init(deviceID: String, relay: MessageRelay, cipher: MessageCipher) {
        self.deviceID = deviceID
        self.relay = relay
        self.cipher = cipher

        var captured: AsyncStream<Message>.Continuation!
        incoming = AsyncStream { captured = $0 }
        inbound = captured

        // Decrypt sealed envelopes from the relay into plaintext messages.
        let sealedStream = relay.subscribe(deviceID)
        let cipher = self.cipher
        let inbound = self.inbound
        pump = Task {
            for await envelope in sealedStream {
                guard let data = try? cipher.open(envelope.ciphertext),
                      let message = try? JSONDecoder().decode(Message.self, from: data) else { continue }
                inbound.yield(message)
            }
            inbound.finish()
        }
    }

    deinit { pump?.cancel(); inbound.finish() }

    public func send(_ message: Message, in conversation: UUID) async throws {
        let data = try JSONEncoder().encode(message)
        let envelope = SealedEnvelope(conversation: conversation, sender: deviceID,
                                      ciphertext: try cipher.seal(data), sentAt: message.sentAt)
        relay.publish(envelope)
    }
}
