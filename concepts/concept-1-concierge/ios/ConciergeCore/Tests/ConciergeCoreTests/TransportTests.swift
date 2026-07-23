import XCTest
import Foundation
@testable import ConciergeCore

final class TransportTests: XCTestCase {

    /// Two devices on the same relay, sharing a key, exchange messages end to end.
    func testTwoDeviceRoundTripInOrder() async throws {
        let relay = InProcessRelay()
        let key = "double-ratchet-stand-in"
        let alice = RelayTransport(deviceID: "alice-iphone", relay: relay, cipher: RotatingXORCipher(key: key))
        let bob   = RelayTransport(deviceID: "bob-iphone",   relay: relay, cipher: RotatingXORCipher(key: key))

        // Start collecting on Bob before Alice sends. AsyncStream buffers, so
        // nothing is lost even though delivery is asynchronous.
        let received = Task { () -> [String] in
            var texts: [String] = []
            for await message in bob.incoming {
                texts.append(message.text)
                if texts.count == 2 { break }
            }
            return texts
        }

        let conversation = UUID()
        try await alice.send(Message(sender: "you", text: "dinner was unreal"), in: conversation)
        try await alice.send(Message(sender: "you", text: "split it 3 ways?"), in: conversation)

        let texts = await received.value
        XCTAssertEqual(texts, ["dinner was unreal", "split it 3 ways?"])
    }

    /// The sender does not receive an echo of its own message from the relay.
    func testSenderDoesNotEchoToItself() async throws {
        let relay = InProcessRelay()
        let alice = RelayTransport(deviceID: "alice", relay: relay, cipher: PlaintextCipher())
        let bob   = RelayTransport(deviceID: "bob",   relay: relay, cipher: PlaintextCipher())

        let bobGot = Task { () -> Message? in
            for await m in bob.incoming { return m }
            return nil
        }
        try await alice.send(Message(sender: "you", text: "ping"), in: UUID())

        let delivered = await bobGot.value
        XCTAssertEqual(delivered?.text, "ping")
        // Relay handled exactly one envelope, addressed from alice's device.
        XCTAssertEqual(relay.log.count, 1)
        XCTAssertEqual(relay.log.first?.sender, "alice")
    }

    /// The relay must only ever hold ciphertext — never the plaintext bytes.
    func testRelayNeverSeesPlaintext() async throws {
        let relay = InProcessRelay()
        let alice = RelayTransport(deviceID: "alice", relay: relay, cipher: RotatingXORCipher(key: "k3y!"))

        try await alice.send(Message(sender: "you", text: "secret dinner $138.60"), in: UUID())

        XCTAssertEqual(relay.log.count, 1)
        let envelope = try XCTUnwrap(relay.log.first)
        let cipherBytes = Array(envelope.ciphertext)
        XCTAssertFalse(Self.contains(cipherBytes, Array("secret dinner".utf8)),
                       "the relay's envelope must not contain plaintext")
    }

    /// A non-empty key actually transforms the bytes, and the round trip is lossless.
    func testCipherSealsAndOpensLosslessly() throws {
        let cipher = RotatingXORCipher(key: "abc")
        let plaintext = Data("split the bill".utf8)
        let sealed = try cipher.seal(plaintext)
        XCTAssertNotEqual(sealed, plaintext)
        XCTAssertEqual(try cipher.open(sealed), plaintext)
    }

    // naive subsequence search
    private static func contains(_ haystack: [UInt8], _ needle: [UInt8]) -> Bool {
        guard !needle.isEmpty, needle.count <= haystack.count else { return false }
        for start in 0...(haystack.count - needle.count) {
            if Array(haystack[start..<start + needle.count]) == needle { return true }
        }
        return false
    }
}
