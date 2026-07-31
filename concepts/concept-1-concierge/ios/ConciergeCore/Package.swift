// swift-tools-version:5.9
import PackageDescription

// The verifiable kernel of the Concierge slice: models, the agent abstraction,
// the idempotent split ledger, and the messaging-transport boundary. No SwiftUI
// and no API keys live here, so it builds and tests headlessly:
//
//     cd concepts/concept-1-concierge/ios/ConciergeCore && swift test
//
// The SwiftUI app (../ConciergeApp) depends on this package.
let package = Package(
    name: "ConciergeCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "ConciergeCore", targets: ["ConciergeCore"]),
    ],
    targets: [
        .target(name: "ConciergeCore"),
        .testTarget(name: "ConciergeCoreTests", dependencies: ["ConciergeCore"]),
    ]
)
