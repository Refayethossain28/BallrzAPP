import XCTest
@testable import ConciergeCore

final class SplitTests: XCTestCase {

    func testPenniesAlwaysSumToTheBill() {
        let p = SplitMath.evenSplit(totalDollars: 138.60, participants: ["you", "Sam", "Alex"])
        XCTAssertNotNil(p)
        XCTAssertEqual(p?.totalCents, 13_860)
        XCTAssertEqual(p?.shares.reduce(0) { $0 + $1.cents }, 13_860)
    }

    func testRemainderGoesToPayer() {
        // 100.00 / 3 = 3334 + 3333 + 3333; the extra penny lands on index 0 (payer).
        let p = SplitMath.evenSplit(totalDollars: 100, participants: ["you", "Sam", "Alex"])!
        XCTAssertEqual(p.shares.first?.name, "you")
        XCTAssertEqual(p.shares.first?.cents, 3_334)
        XCTAssertEqual(p.shares.reduce(0) { $0 + $1.cents }, 10_000)
    }

    func testNotEnoughPeopleReturnsNil() {
        XCTAssertNil(SplitMath.evenSplit(totalDollars: 50, participants: ["you"]))
    }

    func testExecutionIsIdempotent() {
        let ledger = SplitLedger()
        let p = SplitMath.evenSplit(totalDollars: 90, participants: ["you", "Sam"])!
        XCTAssertTrue(ledger.execute(p))   // first confirm runs
        XCTAssertFalse(ledger.execute(p))  // same key => no-op, no double charge
        XCTAssertTrue(ledger.wasExecuted(p))
    }

    func testStubParsesAmountAndPeople() async throws {
        let agent = StubAgent()
        let p = try await agent.proposeSplit(
            from: "Dinner was $138.60, split between me, Sam and Alex",
            roster: ["you", "Sam", "Alex"]
        )
        XCTAssertEqual(p?.shares.count, 3)
        XCTAssertEqual(p?.totalCents, 13_860)
    }

    func testStubStaysQuietWithoutABill() async throws {
        let agent = StubAgent()
        let p = try await agent.proposeSplit(
            from: "that sushi place was unreal",
            roster: ["you", "Sam", "Alex"]
        )
        XCTAssertNil(p)
    }

    func testEveryoneKeywordPullsInWholeGroup() async throws {
        let agent = StubAgent()
        let p = try await agent.proposeSplit(
            from: "the $60 cab, split between everyone",
            roster: ["you", "Sam", "Alex"]
        )
        XCTAssertEqual(p?.shares.count, 3)
    }
}
