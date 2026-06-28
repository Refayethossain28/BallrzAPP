import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import SignIn from './auth/SignIn';
import Layout from './components/Layout';
import Browse from './features/Browse';
import ListingDetail from './features/ListingDetail';
import MyListings from './features/MyListings';
import ComplianceDashboard from './features/ComplianceDashboard';
import TrackProperty from './features/TrackProperty';
import DocumentVault from './features/DocumentVault';
import Rent from './features/Rent';
import NewTenancy from './features/NewTenancy';
import TenancyDetail from './features/TenancyDetail';
import NewProperty from './features/NewProperty';
import Account from './features/Account';
import Chats from './features/Chats';
import DealRoom from './features/DealRoom';
import ContractView from './features/ContractView';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

function Gate() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="centerpage"><p className="sub" style={{ textAlign: 'center' }}>Loading Apex…</p></div>;
  }
  if (!user) return <SignIn />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Browse />} />
        <Route path="/listing/:id" element={<ListingDetail />} />
        <Route path="/landlord" element={<MyListings />} />
        <Route path="/landlord/compliance" element={<ComplianceDashboard />} />
        <Route path="/landlord/track" element={<TrackProperty />} />
        <Route path="/landlord/property/:id" element={<DocumentVault />} />
        <Route path="/landlord/rent" element={<Rent />} />
        <Route path="/landlord/rent/new" element={<NewTenancy />} />
        <Route path="/landlord/rent/:id" element={<TenancyDetail />} />
        <Route path="/landlord/new" element={<NewProperty />} />
        <Route path="/chats" element={<Chats />} />
        <Route path="/deal/:id" element={<DealRoom />} />
        <Route path="/deal/:id/contract" element={<ContractView />} />
        <Route path="/account" element={<Account />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
