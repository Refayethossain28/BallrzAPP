export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  avatar?: string;
}

export type TripStatus = 'upcoming' | 'active' | 'completed' | 'cancelled';
export type ServiceType = 'airport' | 'hourly' | 'day';
export type VehicleType = 's-class' | 'v-class';

export interface Driver {
  id: string;
  name: string;
  phone: string;
  rating: number;
  vehicle: string;
  plate: string;
  photo?: string;
}

export interface Trip {
  id: string;
  serviceType: ServiceType;
  vehicleType: VehicleType;
  status: TripStatus;
  date: string;
  time: string;
  pickup: string;
  dropoff: string;
  passengers: number;
  price: number;
  flightNumber?: string;
  duration?: number;
  driver?: Driver;
  notes?: string;
  bookingRef: string;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  read: boolean;
  type: 'booking' | 'driver' | 'promo' | 'system';
}

export interface PaymentCard {
  id: string;
  type: 'visa' | 'mastercard' | 'amex';
  last4: string;
  expiry: string;
  name: string;
  isDefault: boolean;
}

export interface SavedAddress {
  id: string;
  label: 'Home' | 'Work' | 'Custom';
  address: string;
  icon: string;
}

export interface BookingState {
  serviceType: ServiceType | null;
  vehicleType: VehicleType | null;
  pickup: string;
  dropoff: string;
  airport: string;
  flightNumber: string;
  date: string;
  time: string;
  passengers: number;
  childSeats: boolean;
  luggage: number;
  duration: number;
  notes: string;
  promoCode: string;
  paymentCardId: string;
}

export interface PriceBreakdown {
  baseFare: number;
  extras: number;
  vat: number;
  total: number;
}
