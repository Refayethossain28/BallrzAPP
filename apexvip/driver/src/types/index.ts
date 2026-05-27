export type ServiceType = 'Airport Transfer' | 'Hourly' | 'Day Hire' | 'Point to Point' | 'Hotel Transfer';
export type JobStatus = 'available' | 'upcoming' | 'active' | 'completed' | 'cancelled' | 'declined';
export type TripStatus = 'confirmed' | 'en_route' | 'arrived' | 'onboard' | 'completed';
export type VehicleType = 'Mercedes S-Class' | 'Mercedes V-Class' | 'BMW 7 Series' | 'Range Rover';
export type DocumentStatus = 'verified' | 'pending' | 'expired' | 'missing';

export interface Driver {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  rating: number;
  totalTrips: number;
  memberSince: string;
  avatar?: string;
  licencePlate: string;
  vehicle: Vehicle;
}

export interface Vehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  registration: string;
  type: VehicleType;
}

export interface Job {
  id: string;
  status: JobStatus;
  serviceType: ServiceType;
  clientName: string;
  clientInitials: string;
  clientPhone?: string;
  pickupAddress: string;
  dropoffAddress: string;
  pickupTime: string;
  pickupDate: string;
  estimatedDuration: string;
  estimatedDistance: string;
  distanceToPickup?: string;
  passengers: number;
  luggage?: number;
  flightNumber?: string;
  specialNotes?: string;
  vehicle: VehicleType;
  price: number;
  tip?: number;
  bonus?: number;
}

export interface ActiveTrip extends Job {
  tripStatus: TripStatus;
  startTime?: string;
  endTime?: string;
}

export interface TripRecord {
  id: string;
  date: string;
  pickupAddress: string;
  dropoffAddress: string;
  serviceType: ServiceType;
  duration: string;
  earnings: number;
  tip: number;
  rating?: number;
  clientName: string;
}

export interface EarningsData {
  day: string;
  amount: number;
  trips: number;
}

export interface Notification {
  id: string;
  type: 'job_assigned' | 'booking_update' | 'payout' | 'system' | 'rating';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

export interface DriverDocument {
  id: string;
  name: string;
  status: DocumentStatus;
  expiryDate?: string;
  uploadDate?: string;
}
