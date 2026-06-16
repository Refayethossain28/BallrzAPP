import SwiftUI
import CoreLocation
import Combine

/// Central observable app state — the SwiftUI analogue of the web app's `state` object.
@MainActor
final class AppStore: ObservableObject {
    @Published var user: AppUser?
    @Published var trips: [Trip] = []
    @Published var activeTrip: Trip?
    @Published var chat: [ChatMessage] = []
    @Published var isBooting = true

    // Booking draft
    @Published var pickup = ""
    @Published var dropoff = ""
    @Published var selectedService: ServiceTier?

    var isSignedIn: Bool { user != nil }

    func boot() {
        // Simulated splash. A real build would observe Firebase auth here.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            withAnimation(.easeInOut(duration: 0.4)) { self?.isBooting = false }
        }
    }

    func signIn(email: String) {
        user = AppUser(id: "demo-client", name: "Rafa Hossain",
                       email: email.isEmpty ? DemoData.user.email : email,
                       memberNumber: 42)
        trips = DemoData.trips
    }

    func signOut() {
        user = nil
        trips = []
        activeTrip = nil
        chat = []
    }

    func confirmBooking() {
        guard let service = selectedService else { return }
        let trip = Trip(
            id: "APX-\(Int.random(in: 1000...9999))",
            service: service.name,
            pickup: pickup.isEmpty ? "Current location" : pickup,
            dropoff: dropoff.isEmpty ? "Destination" : dropoff,
            date: "Today", time: "Now", vehicle: service.detail,
            price: service.priceFrom, status: .upcoming,
            driver: "James Harrison", plate: "LX73 ABC", rating: 5.0, flight: nil
        )
        trips.insert(trip, at: 0)
        activeTrip = trip
    }

    // MARK: Chat

    func openChat(for trip: Trip) {
        activeTrip = trip
        if chat.isEmpty {
            chat = [
                ChatMessage(message: "Good morning — I'm 8 minutes away in the S-Class.", fromRole: .driver)
            ]
        }
        ChatService.shared.subscribe(tripId: trip.id) { [weak self] incoming in
            self?.chat = incoming
        }
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let msg = ChatMessage(message: trimmed, fromRole: .client)
        chat.append(msg)
        ChatService.shared.send(msg, tripId: activeTrip?.id ?? "")
    }
}

/// Stub chat transport. Swap the body for Firestore `bookings/{id}/messages` listeners.
final class ChatService {
    static let shared = ChatService()
    private init() {}

    func subscribe(tripId: String, onUpdate: @escaping ([ChatMessage]) -> Void) {
        // Real build: db.collection("bookings").document(tripId)
        //   .collection("messages").order(by: "timestamp").addSnapshotListener { ... }
    }

    func send(_ message: ChatMessage, tripId: String) {
        // Real build: write to Firestore + call the sendChauffeurMessage function.
    }
}

/// Wraps CoreLocation for the pickup pin and live tracking map.
final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var location: CLLocationCoordinate2D?
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func request() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        if let c = locs.last?.coordinate {
            DispatchQueue.main.async { self.location = c }
        }
    }
}
