'use client';

import { useState, useRef } from 'react';
import { FlightOffer, HotelOffer, FlightSearchParams, HotelSearchParams } from '@/types';
import FlightSearch from '@/components/FlightSearch';
import HotelSearch from '@/components/HotelSearch';
import FlightCard from '@/components/FlightCard';
import HotelCard from '@/components/HotelCard';

type Tab = 'flights' | 'hotels';
type SortKey = 'price' | 'duration' | 'stops';

function DemoBanner() {
  return (
    <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-800">
      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>
        <strong>Demo mode</strong> — showing sample data. Add Amadeus API keys to <code className="bg-amber-100 px-1 rounded">.env.local</code> for live results.{' '}
        <a href="https://developers.amadeus.com/register" target="_blank" rel="noopener noreferrer" className="underline font-medium">
          Get free API keys
        </a>
      </span>
    </div>
  );
}

function LoadingSpinner({ color = 'blue' }: { color?: 'blue' | 'emerald' }) {
  const ring = color === 'emerald' ? 'border-emerald-600' : 'border-blue-600';
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <div className={`w-12 h-12 border-4 ${ring} border-t-transparent rounded-full animate-spin`} />
      <p className="text-gray-500 text-sm">Searching for the best deals...</p>
    </div>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  return (
    <div className="text-center py-16">
      <div className="text-5xl mb-3">{tab === 'flights' ? '✈️' : '🏨'}</div>
      <p className="text-gray-500 text-sm">No results found. Try different dates or destinations.</p>
    </div>
  );
}

function sortFlights(flights: FlightOffer[], key: SortKey): FlightOffer[] {
  return [...flights].sort((a, b) => {
    if (key === 'price') return a.price - b.price;
    if (key === 'stops') return a.stops - b.stops;
    if (key === 'duration') {
      const parseISO = (d: string) => {
        const h = parseInt(d.match(/(\d+)H/)?.[1] || '0');
        const m = parseInt(d.match(/(\d+)M/)?.[1] || '0');
        return h * 60 + m;
      };
      return parseISO(a.totalDuration) - parseISO(b.totalDuration);
    }
    return 0;
  });
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>('flights');
  const [flightLoading, setFlightLoading] = useState(false);
  const [hotelLoading, setHotelLoading] = useState(false);
  const [flightResults, setFlightResults] = useState<FlightOffer[]>([]);
  const [hotelResults, setHotelResults] = useState<HotelOffer[]>([]);
  const [flightError, setFlightError] = useState<string | null>(null);
  const [hotelError, setHotelError] = useState<string | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [flightSort, setFlightSort] = useState<SortKey>('price');
  const [hotelSort, setHotelSort] = useState<'price' | 'rating'>('price');
  const resultsRef = useRef<HTMLDivElement>(null);

  async function handleFlightSearch(params: FlightSearchParams) {
    setFlightLoading(true);
    setFlightError(null);
    setHasSearched(true);
    setFlightResults([]);
    try {
      const res = await fetch('/api/flights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFlightResults(data.results || []);
      setIsDemo(data.isDemo || false);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err) {
      setFlightError(err instanceof Error ? err.message : 'Search failed. Please try again.');
    } finally {
      setFlightLoading(false);
    }
  }

  async function handleHotelSearch(params: HotelSearchParams) {
    setHotelLoading(true);
    setHotelError(null);
    setHasSearched(true);
    setHotelResults([]);
    try {
      const res = await fetch('/api/hotels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setHotelResults(data.results || []);
      setIsDemo(data.isDemo || false);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err) {
      setHotelError(err instanceof Error ? err.message : 'Search failed. Please try again.');
    } finally {
      setHotelLoading(false);
    }
  }

  const sortedFlights = sortFlights(flightResults, flightSort);
  const sortedHotels = hotelSort === 'price'
    ? [...hotelResults].sort((a, b) => a.pricePerNight - b.pricePerNight)
    : [...hotelResults].sort((a, b) => (b.rating || 0) - (a.rating || 0));

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 text-white">
        <div className="max-w-5xl mx-auto px-4 pt-10 pb-0">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">✈️</span>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight">TravelDeals</h1>
              <p className="text-blue-300 text-xs">Find the cheapest flights & hotels worldwide</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-6">
            {([
              { id: 'flights' as Tab, label: 'Flights', icon: '✈️' },
              { id: 'hotels' as Tab, label: 'Hotels', icon: '🏨' },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-t-lg text-sm font-semibold transition-colors ${
                  activeTab === tab.id
                    ? 'bg-white text-slate-900'
                    : 'text-blue-200 hover:text-white hover:bg-white/10'
                }`}
              >
                <span>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Search Form Panel */}
      <div className="bg-white shadow-sm border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-4 py-6">
          {activeTab === 'flights' ? (
            <FlightSearch onSearch={handleFlightSearch} loading={flightLoading} />
          ) : (
            <HotelSearch onSearch={handleHotelSearch} loading={hotelLoading} />
          )}
        </div>
      </div>

      {/* Results */}
      <div ref={resultsRef} className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Demo banner */}
        {hasSearched && isDemo && <DemoBanner />}

        {/* Flights results */}
        {activeTab === 'flights' && (
          <>
            {flightLoading && <LoadingSpinner color="blue" />}
            {flightError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm">
                <strong>Error:</strong> {flightError}
              </div>
            )}
            {!flightLoading && !flightError && flightResults.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <p className="text-sm text-gray-600 font-medium">
                    {flightResults.length} flight{flightResults.length !== 1 ? 's' : ''} found
                    {isDemo && <span className="text-amber-600 ml-1">(demo data)</span>}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Sort by:</span>
                    {(['price', 'duration', 'stops'] as SortKey[]).map((key) => (
                      <button
                        key={key}
                        onClick={() => setFlightSort(key)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                          flightSort === key
                            ? 'bg-blue-600 text-white'
                            : 'bg-white text-gray-600 border border-gray-200 hover:border-blue-400'
                        }`}
                      >
                        {key.charAt(0).toUpperCase() + key.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  {sortedFlights.map((flight) => (
                    <FlightCard key={flight.id} flight={flight} />
                  ))}
                </div>
              </div>
            )}
            {!flightLoading && !flightError && hasSearched && flightResults.length === 0 && (
              <EmptyState tab="flights" />
            )}
          </>
        )}

        {/* Hotels results */}
        {activeTab === 'hotels' && (
          <>
            {hotelLoading && <LoadingSpinner color="emerald" />}
            {hotelError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm">
                <strong>Error:</strong> {hotelError}
              </div>
            )}
            {!hotelLoading && !hotelError && hotelResults.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <p className="text-sm text-gray-600 font-medium">
                    {hotelResults.length} hotel{hotelResults.length !== 1 ? 's' : ''} found
                    {isDemo && <span className="text-amber-600 ml-1">(demo data)</span>}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Sort by:</span>
                    {([['price', 'Price'], ['rating', 'Rating']] as [typeof hotelSort, string][]).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setHotelSort(key)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                          hotelSort === key
                            ? 'bg-emerald-600 text-white'
                            : 'bg-white text-gray-600 border border-gray-200 hover:border-emerald-400'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  {sortedHotels.map((hotel) => (
                    <HotelCard key={hotel.id} hotel={hotel} />
                  ))}
                </div>
              </div>
            )}
            {!hotelLoading && !hotelError && hasSearched && hotelResults.length === 0 && (
              <EmptyState tab="hotels" />
            )}
          </>
        )}

        {/* Initial state - feature highlights */}
        {!hasSearched && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
            {[
              {
                icon: '💰',
                title: 'Best Price Guarantee',
                desc: 'We compare hundreds of airlines and hotels to find you the lowest fares.',
              },
              {
                icon: '🔍',
                title: 'Real-time Search',
                desc: 'Live prices from Amadeus travel API covering flights and hotels worldwide.',
              },
              {
                icon: '🌍',
                title: 'Global Coverage',
                desc: 'Search 10,000+ airports and 150,000+ hotels across 190+ countries.',
              },
            ].map((feat) => (
              <div key={feat.title} className="bg-white rounded-xl border border-gray-100 p-5 text-center shadow-sm">
                <div className="text-3xl mb-2">{feat.icon}</div>
                <h3 className="font-semibold text-gray-900 text-sm mb-1">{feat.title}</h3>
                <p className="text-xs text-gray-500 leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-gray-200 mt-12 py-6 text-center text-xs text-gray-400">
        TravelDeals — powered by Amadeus Travel API. Prices are for demonstration purposes.
      </footer>
    </div>
  );
}
