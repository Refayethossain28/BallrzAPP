import SwiftUI
import MapKit

struct TrackingView: View {
    let trip: Trip
    @EnvironmentObject var store: AppStore
    @State private var region = MKCoordinateRegion(
        center: .init(latitude: 51.5074, longitude: -0.1278),
        span: .init(latitudeDelta: 0.03, longitudeDelta: 0.03)
    )
    @State private var driverPos = CLLocationCoordinate2D(latitude: 51.5074, longitude: -0.1278)
    @State private var showChat = false
    private let timer = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    private var driverAnnotations: [DriverPin] { [DriverPin(coordinate: driverPos)] }

    var body: some View {
        ZStack(alignment: .bottom) {
            Map(coordinateRegion: $region, annotationItems: driverAnnotations) { pin in
                MapAnnotation(coordinate: pin.coordinate) {
                    ZStack {
                        Circle().fill(Brand.gold.opacity(0.25)).frame(width: 38, height: 38)
                        Circle().fill(Brand.gold).frame(width: 14, height: 14)
                    }
                }
            }
            .ignoresSafeArea()

            card
        }
        .navigationTitle("Tracking")
        .navigationBarTitleDisplayMode(.inline)
        .onReceive(timer) { _ in
            // Simulated movement; a real build subscribes to drivers/{id} in Firestore.
            withAnimation(.linear(duration: 3)) {
                driverPos.latitude  += 0.0008
                driverPos.longitude += 0.0006
            }
        }
        .sheet(isPresented: $showChat) { ChatView() }
    }

    private var card: some View {
        VStack(spacing: 14) {
            Capsule().fill(Brand.fg4).frame(width: 38, height: 5)

            Text("8 min")
                .font(Brand.serif(36, weight: .light)).foregroundStyle(Brand.gold)
            Text("ESTIMATED ARRIVAL").font(.system(size: 10, weight: .semibold))
                .tracking(2).foregroundStyle(Brand.fg4)

            HStack(spacing: 14) {
                Circle().fill(LinearGradient(colors: [.white, Brand.goldDeep],
                                             startPoint: .top, endPoint: .bottom))
                    .frame(width: 48, height: 48)
                    .overlay(Text(initials(trip.driver)).font(.system(size: 15, weight: .bold)).foregroundStyle(.black))
                VStack(alignment: .leading, spacing: 2) {
                    Text(trip.driver).font(.system(size: 15, weight: .bold)).foregroundStyle(Brand.fg)
                    Text("\(trip.plate) · \(trip.vehicle)").font(.system(size: 12)).foregroundStyle(Brand.fg3)
                }
                Spacer()
                Link(destination: URL(string: "tel:+447700000000")!) {
                    Image(systemName: "phone.fill").foregroundStyle(Brand.fg)
                        .frame(width: 40, height: 40)
                        .background(Brand.surface2).clipShape(Circle())
                }
            }

            Button {
                store.openChat(for: trip); showChat = true
            } label: {
                HStack {
                    Image(systemName: "message.fill").foregroundStyle(Brand.gold)
                    Text("Message your chauffeur").foregroundStyle(Brand.fg).font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(Brand.fg4).font(.system(size: 12))
                }
                .padding(14)
                .background(Brand.surface)
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Brand.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding(22)
        .background(Brand.bgDeep.opacity(0.97).clipShape(RoundedRectangle(cornerRadius: 32)))
        .overlay(RoundedRectangle(cornerRadius: 32).stroke(Brand.border, lineWidth: 1))
        .padding(.horizontal, 10)
    }

    private func initials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined()
    }
}

struct DriverPin: Identifiable {
    let id = UUID()
    let coordinate: CLLocationCoordinate2D
}

#Preview {
    NavigationStack { TrackingView(trip: DemoData.trips[0]).environmentObject(AppStore()) }
}
