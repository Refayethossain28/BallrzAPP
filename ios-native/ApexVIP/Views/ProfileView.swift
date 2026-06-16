import SwiftUI

struct ProfileView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        NavigationStack {
            ZStack {
                Brand.bg.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 16) {
                        header
                        Card {
                            VStack(spacing: 0) {
                                row(icon: "creditcard.fill", title: "Payment methods")
                                Divider().overlay(Brand.divider)
                                row(icon: "star.fill", title: "ApexVIP Rewards")
                                Divider().overlay(Brand.divider)
                                row(icon: "mappin.and.ellipse", title: "Saved addresses")
                                Divider().overlay(Brand.divider)
                                row(icon: "bell.fill", title: "Notifications")
                            }
                        }
                        .padding(0)

                        Button("Sign out") { store.signOut() }
                            .buttonStyle(GlassButtonStyle())
                    }
                    .padding(22)
                }
            }
            .navigationTitle("Profile")
            .toolbarBackground(Brand.bgDeep, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Circle().fill(LinearGradient(colors: [Brand.gold, Brand.goldDeep], startPoint: .top, endPoint: .bottom))
                .frame(width: 72, height: 72)
                .overlay(Text(initials).font(.system(size: 24, weight: .bold)).foregroundStyle(.black))
            Text(store.user?.name ?? "Guest").font(.system(size: 20, weight: .bold)).foregroundStyle(Brand.fg)
            if let n = store.user?.memberNumber {
                Text("Charter Member #\(n)").font(.system(size: 12)).foregroundStyle(Brand.gold).tracking(1)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    private func row(icon: String, title: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon).foregroundStyle(Brand.gold).frame(width: 24)
            Text(title).font(.system(size: 15)).foregroundStyle(Brand.fg)
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Brand.fg4)
        }
        .padding(.vertical, 14)
    }

    private var initials: String {
        (store.user?.name ?? "G").split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined()
    }
}

#Preview {
    let s = AppStore(); s.signIn(email: "")
    return ProfileView().environmentObject(s)
}
