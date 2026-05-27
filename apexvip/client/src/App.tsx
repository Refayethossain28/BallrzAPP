import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { BookingProvider } from './context/BookingContext';
import { useAuth } from './context/AuthContext';

import SplashScreen from './pages/SplashScreen';
import Login from './pages/Login';
import Register from './pages/Register';
import Home from './pages/Home';
import BookAirport from './pages/BookAirport';
import BookHourly from './pages/BookHourly';
import BookDay from './pages/BookDay';
import VehicleSelect from './pages/VehicleSelect';
import BookingSummary from './pages/BookingSummary';
import BookingConfirmed from './pages/BookingConfirmed';
import TripsList from './pages/TripsList';
import TripDetail from './pages/TripDetail';
import Profile from './pages/Profile';
import Notifications from './pages/Notifications';
import PaymentMethods from './pages/PaymentMethods';
import LoadingSpinner from './components/LoadingSpinner';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0a',
      }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0a',
      }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }
  if (isAuthenticated) return <Navigate to="/home" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<PublicRoute><SplashScreen /></PublicRoute>} />
      <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
      <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
      <Route path="/home" element={<ProtectedRoute><Home /></ProtectedRoute>} />
      <Route path="/book/airport" element={<ProtectedRoute><BookAirport /></ProtectedRoute>} />
      <Route path="/book/hourly" element={<ProtectedRoute><BookHourly /></ProtectedRoute>} />
      <Route path="/book/day" element={<ProtectedRoute><BookDay /></ProtectedRoute>} />
      <Route path="/book/vehicle" element={<ProtectedRoute><VehicleSelect /></ProtectedRoute>} />
      <Route path="/book/summary" element={<ProtectedRoute><BookingSummary /></ProtectedRoute>} />
      <Route path="/book/confirmed" element={<ProtectedRoute><BookingConfirmed /></ProtectedRoute>} />
      <Route path="/trips" element={<ProtectedRoute><TripsList /></ProtectedRoute>} />
      <Route path="/trips/:id" element={<ProtectedRoute><TripDetail /></ProtectedRoute>} />
      <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
      <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
      <Route path="/payment" element={<ProtectedRoute><PaymentMethods /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <BookingProvider>
          <AppRoutes />
        </BookingProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
