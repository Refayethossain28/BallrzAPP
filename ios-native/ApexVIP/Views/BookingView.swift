import SwiftUI

struct BookingView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmed = false

    var body: some View {
        NavigationStack {
            ZStack {
                Brand.bg.ignoresSafeArea()
                if confirmed {
                    confirmedView
                } else {
                    form
                }
            }
            .navigationTitle(confirmed ? "" : "Book a journey")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }.tint(Brand.gold)
                }
            }
            .toolbarBackground(Brand.bgDeep, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Card {
                    VStack(alignment: .leading, spacing: 14) {
                        labeledField("Pickup", systemImage: "circle.fill", text: $store.pickup, tint: Brand.gold)
                        Divider().overlay(Brand.divider)
                        labeledField("Drop-off", systemImage: "mappin.circle.fill", text: $store.dropoff, tint: Brand.fg3)
                    }
                }

                SectionLabel("Choose your class")
                ForEach(DemoData.services) { svc in
                    Button { store.selectedService = svc } label: {
                        HStack(spacing: 14) {
                            Text(svc.emoji).font(.system(size: 24))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(svc.name).font(.system(size: 15, weight: .bold)).foregroundStyle(Brand.fg)
                                Text(svc.detail).font(.system(size: 12)).foregroundStyle(Brand.fg3)
                            }
                            Spacer()
                            Text("from \(svc.priceFrom)").font(.system(size: 14, weight: .bold)).foregroundStyle(Brand.gold)
                        }
                        .padding(16)
                        .background(Brand.surface)
                        .overlay(RoundedRectangle(cornerRadius: 16)
                            .stroke(store.selectedService?.id == svc.id ? Brand.gold : Brand.border,
                                    lineWidth: store.selectedService?.id == svc.id ? 2 : 1))
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                    }
                }

                Button("Confirm booking") {
                    store.confirmBooking()
                    withAnimation { confirmed = true }
                }
                .buttonStyle(GoldButtonStyle())
                .disabled(store.selectedService == nil)
                .opacity(store.selectedService == nil ? 0.5 : 1)
                .padding(.top, 8)
            }
            .padding(20)
        }
    }

    private var confirmedView: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64)).foregroundStyle(Brand.green)
            Text("Booking Confirmed")
                .font(Brand.serif(32, weight: .light)).foregroundStyle(Brand.fg)
            if let t = store.activeTrip {
                Text(t.id).font(.system(size: 20, weight: .bold)).tracking(3).foregroundStyle(Brand.fg)
                Text("\(t.driver) · \(t.vehicle)").font(.system(size: 14)).foregroundStyle(Brand.fg3)
            }
            NavigationLink {
                if let t = store.activeTrip { TrackingView(trip: t) }
            } label: { Text("Track my driver") }
            .buttonStyle(GoldButtonStyle())
            .padding(.top, 20)

            Button("Message driver") {
                if let t = store.activeTrip { store.openChat(for: t) }
            }
            .buttonStyle(GlassButtonStyle())

            Button("Done") { dismiss() }.tint(Brand.fg3).padding(.top, 4)
        }
        .padding(28)
    }

    @ViewBuilder
    private func labeledField(_ label: String, systemImage: String, text: Binding<String>, tint: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage).foregroundStyle(tint).font(.system(size: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.system(size: 11)).foregroundStyle(Brand.fg3)
                TextField("", text: text, prompt: Text("Enter \(label.lowercased())").foregroundColor(Brand.fg4))
                    .foregroundStyle(Brand.fg)
            }
        }
    }
}

#Preview {
    let s = AppStore(); s.signIn(email: "")
    return BookingView().environmentObject(s)
}
