'use client';

import { useState } from 'react';
import { FlightSearchParams } from '@/types';

interface Props {
  onSearch: (params: FlightSearchParams) => void;
  loading: boolean;
}

const today = new Date().toISOString().split('T')[0];

export default function FlightSearch({ onSearch, loading }: Props) {
  const [tripType, setTripType] = useState<'oneway' | 'roundtrip'>('roundtrip');
  const [form, setForm] = useState<FlightSearchParams>({
    origin: '',
    destination: '',
    departureDate: '',
    returnDate: '',
    adults: 1,
    travelClass: 'ECONOMY',
  });

  function set(key: keyof FlightSearchParams, value: string | number) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const params = { ...form };
    if (tripType === 'oneway') delete params.returnDate;
    onSearch(params);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex gap-4 mb-2">
        {(['roundtrip', 'oneway'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTripType(t)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              tripType === t
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t === 'roundtrip' ? 'Round Trip' : 'One Way'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            From
          </label>
          <input
            type="text"
            placeholder="e.g. JFK or New York"
            value={form.origin}
            onChange={(e) => set('origin', e.target.value.toUpperCase())}
            required
            maxLength={3}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-400 mt-0.5">3-letter IATA code (e.g. JFK, LAX)</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            To
          </label>
          <input
            type="text"
            placeholder="e.g. LAX or Los Angeles"
            value={form.destination}
            onChange={(e) => set('destination', e.target.value.toUpperCase())}
            required
            maxLength={3}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-400 mt-0.5">3-letter IATA code (e.g. CDG, LHR)</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Departure Date
          </label>
          <input
            type="date"
            min={today}
            value={form.departureDate}
            onChange={(e) => set('departureDate', e.target.value)}
            required
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        {tripType === 'roundtrip' && (
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Return Date
            </label>
            <input
              type="date"
              min={form.departureDate || today}
              value={form.returnDate}
              onChange={(e) => set('returnDate', e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Passengers
          </label>
          <select
            value={form.adults}
            onChange={(e) => set('adults', parseInt(e.target.value))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n}>{n} {n === 1 ? 'Adult' : 'Adults'}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Cabin Class
          </label>
          <select
            value={form.travelClass}
            onChange={(e) => set('travelClass', e.target.value as FlightSearchParams['travelClass'])}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          >
            <option value="ECONOMY">Economy</option>
            <option value="PREMIUM_ECONOMY">Premium Economy</option>
            <option value="BUSINESS">Business</option>
            <option value="FIRST">First Class</option>
          </select>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 rounded-xl transition-colors text-sm"
      >
        {loading ? 'Searching Flights...' : 'Search Flights'}
      </button>
    </form>
  );
}
