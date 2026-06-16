import SwiftUI
import MapKit

struct HomeView: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var loc = LocationManager()
    @State private var region = MKCoordinateRegion(
        center: .init(latitude: 51.5074, longitude: -0.1278),
        span: .init(latitudeDelta: 0.06, longitudeDelta: 0.06)
    )
    @State private var showBooking = false

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Map(coordinateRegion: $region,
                    showsUserLocation: true,
                    annotationItems: DemoData.recommendations) { rec in
                    MapAnnotation(coordinate: rec.coordinate) {
                        Text(rec.emoji).font(.system(size: 22))
                    }
                }
                .ignoresSafeArea()

                sheet
            }
            .navigationBarHidden(true)
            .onAppear {
                loc.request()
                store.user = store.user ?? DemoData.user
            }
            .onChange(of: loc.location?.latitude) { _ in
                if let c = loc.location { region.center = c }
            }
            .sheet(isPresented: $showBooking) { BookingView() }
        }
    }

    private var sheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Capsule().fill(Brand.fg4).frame(width: 38, height: 5)
                .frame(maxWidth: .infinity)

            Text("Good \(greeting), \(store.user?.name.split(separator: " ").first.map(String.init) ?? "there")")
                .font(Brand.serif(26, weight: .regular))
                .foregroundStyle(Brand.fg)

            Button {
                showBooking = true
            } label: {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(Brand.fg4)
                    Text("Where to?").foregroundStyle(Brand.fg3)
                    Spacer()
                }
                .padding(.vertical, 15).padding(.horizontal, 16)
                .background(Brand.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }

            SectionLabel("Choose your class")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(DemoData.services) { svc in
                        Button {
                            store.selectedService = svc
                            showBooking = true
                        } label: { serviceCard(svc) }
                    }
                }
            }
        }
        .padding(22)
        .padding(.bottom, 8)
        .background(
            Brand.bgDeep.opacity(0.97)
                .clipShape(RoundedRectangle(cornerRadius: 32))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 32).stroke(Brand.border, lineWidth: 1)
        )
    }

    private func serviceCard(_ svc: ServiceTier) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(svc.emoji).font(.system(size: 26))
            Text(svc.name).font(.system(size: 14, weight: .bold)).foregroundStyle(Brand.fg)
            Text(svc.detail).font(.system(size: 11)).foregroundStyle(Brand.fg3)
            Text("from \(svc.priceFrom)").font(.system(size: 12, weight: .semibold)).foregroundStyle(Brand.gold)
        }
        .frame(width: 130, alignment: .leading)
        .padding(14)
        .background(Brand.surface)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Brand.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        return h < 12 ? "morning" : (h < 18 ? "afternoon" : "evening")
    }
}

#Preview {
    let s = AppStore(); s.signIn(email: "")
    return HomeView().environmentObject(s)
}
