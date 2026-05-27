export type BookingStatus = 'pending' | 'confirmed' | 'active' | 'completed' | 'cancelled';
export type DriverStatus = 'online' | 'offline' | 'on-trip';
export type VehicleStatus = 'available' | 'on-trip' | 'maintenance';
export type ClientTier = 'Standard' | 'VIP' | 'VVIP';
export type VehicleClass = 'S-Class' | 'V-Class';
export type ServiceType = 'airport' | 'hourly' | 'day';

export interface Booking {
  id: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  driverId?: string;
  driverName?: string;
  vehicleId?: string;
  vehicleReg?: string;
  vehicleClass?: VehicleClass;
  pickup: string;
  dropoff: string;
  dateTime: string;
  status: BookingStatus;
  price: number;
  serviceType: ServiceType;
  notes?: string;
  flightNumber?: string;
  passengers: number;
  timeline: BookingEvent[];
}

export interface BookingEvent {
  id: string;
  timestamp: string;
  event: string;
  description: string;
}

export interface Driver {
  id: string;
  name: string;
  email: string;
  phone: string;
  rating: number;
  status: DriverStatus;
  vehicleId?: string;
  vehicleReg?: string;
  vehicleClass?: VehicleClass;
  totalTrips: number;
  earningsThisMonth: number;
  joinedDate: string;
  licenseNumber: string;
  licenseExpiry: string;
  dbsVerified: boolean;
  insuranceVerified: boolean;
  photoUrl?: string;
  address: string;
  emergencyContact: string;
  earnings: MonthlyEarning[];
}

export interface MonthlyEarning {
  month: string;
  amount: number;
  trips: number;
}

export interface Client {
  id: string;
  name: string;
  email: string;
  phone: string;
  totalBookings: number;
  totalSpent: number;
  joinedDate: string;
  tier: ClientTier;
  address?: string;
  notes?: string;
  paymentMethods: PaymentMethod[];
  preferences?: string;
  lastBooking?: string;
}

export interface PaymentMethod {
  id: string;
  type: 'card' | 'account';
  last4?: string;
  brand?: string;
  isDefault: boolean;
}

export interface Vehicle {
  id: string;
  make: string;
  model: string;
  class: VehicleClass;
  year: number;
  color: string;
  registration: string;
  status: VehicleStatus;
  assignedDriverId?: string;
  assignedDriverName?: string;
  mileage: number;
  lastService: string;
  nextService: string;
  insuranceExpiry: string;
  motExpiry: string;
  maintenanceLog: MaintenanceEntry[];
  specs: VehicleSpecs;
}

export interface VehicleSpecs {
  seats: number;
  luggage: number;
  transmission: string;
  fuel: string;
  color: string;
}

export interface MaintenanceEntry {
  id: string;
  date: string;
  type: string;
  description: string;
  cost: number;
  mileage: number;
}

export interface PricingRate {
  id: string;
  name: string;
  sClass: number;
  vClass: number;
  description?: string;
}

export interface PeakSurcharge {
  id: string;
  name: string;
  percentage: number;
  startTime: string;
  endTime: string;
  days: string;
}

export interface Notification {
  id: string;
  type: 'booking' | 'driver' | 'payment' | 'system';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  bookingId?: string;
  driverId?: string;
}

export interface ChartDataPoint {
  date: string;
  bookings: number;
  revenue: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'superadmin' | 'admin' | 'operator';
  lastLogin: string;
  active: boolean;
}
