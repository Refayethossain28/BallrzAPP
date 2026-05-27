import React, { createContext, useContext, useState, ReactNode } from 'react';
import { BookingState, ServiceType, VehicleType } from '../types';

const defaultBookingState: BookingState = {
  serviceType: null,
  vehicleType: null,
  pickup: '',
  dropoff: '',
  airport: '',
  flightNumber: '',
  date: '',
  time: '',
  passengers: 1,
  childSeats: false,
  luggage: 1,
  duration: 2,
  notes: '',
  promoCode: '',
  paymentCardId: 'card-001',
};

interface BookingContextType {
  booking: BookingState;
  setBookingField: <K extends keyof BookingState>(field: K, value: BookingState[K]) => void;
  setBookingFields: (updates: Partial<BookingState>) => void;
  resetBooking: () => void;
  setServiceType: (type: ServiceType) => void;
  setVehicleType: (type: VehicleType) => void;
}

const BookingContext = createContext<BookingContextType | undefined>(undefined);

export function BookingProvider({ children }: { children: ReactNode }) {
  const [booking, setBooking] = useState<BookingState>(defaultBookingState);

  const setBookingField = <K extends keyof BookingState>(field: K, value: BookingState[K]) => {
    setBooking(prev => ({ ...prev, [field]: value }));
  };

  const setBookingFields = (updates: Partial<BookingState>) => {
    setBooking(prev => ({ ...prev, ...updates }));
  };

  const resetBooking = () => {
    setBooking(defaultBookingState);
  };

  const setServiceType = (type: ServiceType) => {
    setBooking(prev => ({ ...prev, serviceType: type }));
  };

  const setVehicleType = (type: VehicleType) => {
    setBooking(prev => ({ ...prev, vehicleType: type }));
  };

  return (
    <BookingContext.Provider
      value={{
        booking,
        setBookingField,
        setBookingFields,
        resetBooking,
        setServiceType,
        setVehicleType,
      }}
    >
      {children}
    </BookingContext.Provider>
  );
}

export function useBooking() {
  const context = useContext(BookingContext);
  if (!context) throw new Error('useBooking must be used within BookingProvider');
  return context;
}
