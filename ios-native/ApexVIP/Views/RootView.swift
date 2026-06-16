import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: AppStore

    init() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Brand.bgDeep)
        appearance.stackedLayoutAppearance.selected.iconColor = UIColor(Brand.gold)
        appearance.stackedLayoutAppearance.selected.titleTextAttributes = [.foregroundColor: UIColor(Brand.gold)]
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "house.fill") }
            TripsView()
                .tabItem { Label("Trips", systemImage: "calendar") }
            ProfileView()
                .tabItem { Label("Profile", systemImage: "person.fill") }
        }
        .tint(Brand.gold)
    }
}

#Preview {
    let s = AppStore(); s.signIn(email: "")
    return RootView().environmentObject(s)
}
