import React, { createContext, useContext, useState, useEffect } from 'react';
import type { Driver } from '../types';
import { mockDriver } from '../data/mockData';

interface AuthContextType {
  driver: Driver | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [driver, setDriver] = useState<Driver | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('apexvip_driver_auth');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.authenticated) {
          setDriver(mockDriver);
        }
      } catch {
        localStorage.removeItem('apexvip_driver_auth');
      }
    }
  }, []);

  const login = async (email: string, password: string): Promise<boolean> => {
    if (email === 'driver@apexvip.com' && password === 'driver123') {
      setDriver(mockDriver);
      localStorage.setItem('apexvip_driver_auth', JSON.stringify({ authenticated: true, email }));
      return true;
    }
    return false;
  };

  const logout = () => {
    setDriver(null);
    localStorage.removeItem('apexvip_driver_auth');
  };

  return (
    <AuthContext.Provider value={{ driver, isAuthenticated: !!driver, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
