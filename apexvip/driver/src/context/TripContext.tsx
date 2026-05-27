import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import type { Job, ActiveTrip, TripStatus } from '../types';
import { jobRequestMock } from '../data/mockData';

interface TripContextType {
  isAvailable: boolean;
  setAvailable: (val: boolean) => void;
  pendingJob: Job | null;
  activeTrip: ActiveTrip | null;
  acceptJob: (job: Job) => void;
  declineJob: () => void;
  updateTripStatus: (status: TripStatus) => void;
  completeTrip: () => void;
  todayTrips: number;
  todayEarnings: number;
}

const TripContext = createContext<TripContextType | undefined>(undefined);

export function TripProvider({ children }: { children: React.ReactNode }) {
  const [isAvailable, setIsAvailableState] = useState(false);
  const [pendingJob, setPendingJob] = useState<Job | null>(null);
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [todayTrips, setTodayTrips] = useState(3);
  const [todayEarnings, setTodayEarnings] = useState(252);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setAvailable = useCallback((val: boolean) => {
    setIsAvailableState(val);
    if (!val) {
      setPendingJob(null);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else {
      timerRef.current = setTimeout(() => {
        setPendingJob(jobRequestMock);
      }, 3000);
    }
  }, []);

  const acceptJob = useCallback((job: Job) => {
    setPendingJob(null);
    setActiveTrip({
      ...job,
      tripStatus: 'confirmed',
    });
  }, []);

  const declineJob = useCallback(() => {
    setPendingJob(null);
    // After 3s, show another job request
    timerRef.current = setTimeout(() => {
      setPendingJob(jobRequestMock);
    }, 3000);
  }, []);

  const updateTripStatus = useCallback((status: TripStatus) => {
    setActiveTrip((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, tripStatus: status };
      if (status === 'onboard' && !prev.startTime) {
        updated.startTime = new Date().toISOString();
      }
      return updated;
    });
  }, []);

  const completeTrip = useCallback(() => {
    setActiveTrip((prev) => {
      if (!prev) return prev;
      return { ...prev, tripStatus: 'completed', endTime: new Date().toISOString() };
    });
    setTimeout(() => {
      setActiveTrip(null);
      setTodayTrips((n) => n + 1);
      setTodayEarnings((e) => e + (activeTrip?.price ?? 0));
    }, 1500);
  }, [activeTrip]);

  return (
    <TripContext.Provider
      value={{
        isAvailable,
        setAvailable,
        pendingJob,
        activeTrip,
        acceptJob,
        declineJob,
        updateTripStatus,
        completeTrip,
        todayTrips,
        todayEarnings,
      }}
    >
      {children}
    </TripContext.Provider>
  );
}

export function useTrip() {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error('useTrip must be used within TripProvider');
  return ctx;
}
