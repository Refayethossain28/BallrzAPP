import SwiftUI
import ConciergeCore

@main
struct ConciergeApp: App {
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ConversationView(store: ConversationStore())
            }
        }
    }
}
