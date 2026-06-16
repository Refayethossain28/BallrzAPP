import SwiftUI

struct TripsView: View {
    @EnvironmentObject var store: AppStore
    @State private var tab: TripStatus = .upcoming

    private var list: [Trip] {
        store.trips.filter { tab == .upcoming ? $0.status == .upcoming : $0.status == .completed }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Brand.bg.ignoresSafeArea()
                VStack(spacing: 0) {
                    Picker("", selection: $tab) {
                        Text("Upcoming").tag(TripStatus.upcoming)
                        Text("Past").tag(TripStatus.completed)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 22).padding(.top, 8)

                    ScrollView {
                        VStack(spacing: 12) {
                            if list.isEmpty {
                                emptyState
                            } else {
                                ForEach(list) { trip in
                                    NavigationLink { TrackingView(trip: trip) } label: {
                                        tripCard(trip)
                                    }
                                }
                            }
                        }
                        .padding(22)
                    }
                }
            }
            .navigationTitle("Trips")
            .toolbarBackground(Brand.bgDeep, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    private func tripCard(_ t: Trip) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t.service).font(.system(size: 16, weight: .bold)).foregroundStyle(Brand.fg)
                        Text("\(t.date) · \(t.time)").font(.system(size: 12)).foregroundStyle(Brand.fg3)
                    }
                    Spacer()
                    tag(t.status)
                }
                routeRow(dot: Brand.gold, text: t.pickup)
                routeRow(dot: Brand.fg4, text: t.dropoff)
                Divider().overlay(Brand.divider)
                HStack {
                    Text(t.vehicle).font(.system(size: 13)).foregroundStyle(Brand.fg3)
                    Spacer()
                    if t.status == .upcoming {
                        Label("Message", systemImage: "message.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Brand.gold)
                            .onTapGesture { store.openChat(for: t) }
                    }
                    Text(t.price).font(.system(size: 15, weight: .bold)).foregroundStyle(Brand.fg)
                }
            }
        }
    }

    private func routeRow(dot: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(dot).frame(width: 8, height: 8).padding(.top, 5)
            Text(text).font(.system(size: 14)).foregroundStyle(Brand.fg2)
        }
    }

    private func tag(_ status: TripStatus) -> some View {
        let (label, color): (String, Color) = switch status {
        case .upcoming:  ("Upcoming", Brand.gold)
        case .completed: ("Completed", Brand.fg3)
        case .cancelled: ("Cancelled", Brand.red)
        }
        return Text(label)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Text(tab == .upcoming ? "🚘" : "🕐").font(.system(size: 40))
            Text(tab == .upcoming ? "No journeys booked" : "No past journeys")
                .font(Brand.serif(24, weight: .light)).foregroundStyle(Brand.fg)
        }
        .padding(.top, 80)
    }
}

#Preview {
    let s = AppStore(); s.signIn(email: "")
    return TripsView().environmentObject(s)
}
