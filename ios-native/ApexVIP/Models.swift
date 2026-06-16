import Foundation
import CoreLocation

// MARK: - Domain models (mirror the web app's data shapes)

struct AppUser: Identifiable, Codable, Equatable {
    var id: String
    var name: String
    var email: String
    var memberNumber: Int?
}

enum TripStatus: String, Codable {
    case upcoming, completed, cancelled
}

struct Trip: Identifiable, Codable, Equatable {
    var id: String
    var service: String
    var pickup: String
    var dropoff: String
    var date: String
    var time: String
    var vehicle: String
    var price: String
    var status: TripStatus
    var driver: String
    var plate: String
    var rating: Double
    var flight: String?
}

struct ServiceTier: Identifiable {
    let id = UUID()
    let name: String
    let detail: String
    let priceFrom: String
    let emoji: String
}

struct Recommendation: Identifiable {
    let id = UUID()
    let name: String
    let category: String
    let emoji: String
    let coordinate: CLLocationCoordinate2D
}

enum ChatRole: String, Codable {
    case client, driver
}

struct ChatMessage: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var message: String
    var fromRole: ChatRole
    var timestamp: Date = Date()
}

// MARK: - Demo data (the Firebase data layer would replace DemoData at runtime)

enum DemoData {
    static let user = AppUser(
        id: "demo-client",
        name: "Rafa Hossain",
        email: "rafa_hossain@icloud.com",
        memberNumber: 42
    )

    static let services: [ServiceTier] = [
        .init(name: "Executive",  detail: "Mercedes E-Class",  priceFrom: "£45",  emoji: "🚗"),
        .init(name: "Luxury",     detail: "Mercedes S-Class",  priceFrom: "£75",  emoji: "🚘"),
        .init(name: "SUV",        detail: "Range Rover",       priceFrom: "£90",  emoji: "🚙"),
        .init(name: "Airport",    detail: "Meet & greet",      priceFrom: "£65",  emoji: "✈️")
    ]

    static let recommendations: [Recommendation] = [
        .init(name: "The Ritz London", category: "Hotel",    emoji: "🏨", coordinate: .init(latitude: 51.5067, longitude: -0.1438)),
        .init(name: "Nobu London",     category: "Dining",   emoji: "🍣", coordinate: .init(latitude: 51.5075, longitude: -0.1458)),
        .init(name: "Harrods",         category: "Shopping", emoji: "🛍", coordinate: .init(latitude: 51.4994, longitude: -0.1632)),
        .init(name: "The Shard",       category: "View",     emoji: "🏙", coordinate: .init(latitude: 51.5045, longitude: -0.0865)),
        .init(name: "Claridge's",      category: "Hotel",    emoji: "🏰", coordinate: .init(latitude: 51.5120, longitude: -0.1479))
    ]

    static let trips: [Trip] = [
        .init(id: "APX-4821", service: "Luxury · S-Class", pickup: "Mayfair, London",
              dropoff: "Heathrow Terminal 5", date: "Tomorrow", time: "08:30",
              vehicle: "Mercedes S-Class", price: "£95", status: .upcoming,
              driver: "James Harrison", plate: "LX73 ABC", rating: 5.0, flight: "BA 287"),
        .init(id: "APX-4790", service: "Executive", pickup: "The Shard", dropoff: "Canary Wharf",
              date: "12 Jun", time: "19:15", vehicle: "Mercedes E-Class", price: "£62",
              status: .completed, driver: "Daniel Cole", plate: "LR21 XYZ", rating: 4.9, flight: nil),
        .init(id: "APX-4755", service: "Airport Transfer", pickup: "Gatwick North",
              dropoff: "Kensington", date: "5 Jun", time: "14:00", vehicle: "Range Rover",
              price: "£110", status: .completed, driver: "Omar Said", plate: "LG70 RVR",
              rating: 5.0, flight: "EK 015")
    ]
}
