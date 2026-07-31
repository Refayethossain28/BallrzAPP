export interface FlightSearchParams {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  travelClass: 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
}

export interface FlightSegment {
  airline: string;
  airlineCode: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  duration: string;
}

export interface FlightOffer {
  id: string;
  segments: FlightSegment[];
  returnSegments?: FlightSegment[];
  totalDuration: string;
  stops: number;
  price: number;
  currency: string;
  cabinClass: string;
  seatsAvailable?: number;
  isDemo?: boolean;
}

export interface HotelSearchParams {
  cityCode: string;
  cityName?: string;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  rooms: number;
}

export interface HotelOffer {
  id: string;
  name: string;
  stars: number;
  rating?: number;
  reviewCount?: number;
  address: string;
  pricePerNight: number;
  totalPrice?: number;
  currency: string;
  amenities: string[];
  description?: string;
  isDemo?: boolean;
}
