import SwiftUI

@main
struct ApexVIPApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            ZStack {
                Brand.bg.ignoresSafeArea()

                if store.isBooting {
                    SplashView()
                        .transition(.opacity)
                } else if !store.isSignedIn {
                    LoginView()
                        .transition(.opacity)
                } else {
                    RootView()
                        .transition(.opacity)
                }
            }
            .environmentObject(store)
            .preferredColorScheme(.dark)
            .onAppear { store.boot() }
        }
    }
}
