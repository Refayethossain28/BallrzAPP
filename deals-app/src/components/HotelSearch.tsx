'use client';

import { useState } from 'react';
import { HotelSearchParams } from '@/types';

interface Props {
  onSearch: (params: HotelSearchParams) => void;
  loading: boolean;
}

const today = new Date().toISOString().split('T')[0];

const POPULAR_CITIES = [
  { code: 'NYC', name: 'New York' },
  { code: 'LAX', name: 'Los Angeles' },
  { code: 'LON', name: 'London' },
  { code: 'PAR', name: 'Paris' },
  { code: 'DXB', name: 'Dubai' },
  { code: 'TYO', name: 'Tokyo' },
  { code: 'SYD', name: 'Sydney' },
  { code: 'BCN', name: 'Barcelona' },
];

export default function HotelSearch({ onSearch, loading }: Props) {
  const [form, setForm] = useState<HotelSearchParams>({
    cityCode: '',
    cityName: '',
    checkInDate: '',
    checkOutDate: '',
    adults: 2,
    rooms: 1,
  });

  function set(key: keyof HotelSearchParams, value: string | number) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearch(form);
  }

  function selectCity(code: string, name: string) {
    setForm((f) => ({ ...f, cityCode: code, cityName: name }));
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
          Destination City
        </label>
        <input
          type="text"
          placeholder="City code (e.g. NYC, LON, PAR)"
          value={form.cityCode}
          onChange={(e) => set('cityCode', e.target.value.toUpperCase())}
          required
          maxLength={3}
          className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
        />
        <div className="flex flex-wrap gap-1.5 mt-2">
          {POPULAR_CITIES.map((city) => (
            <button
              key={city.code}
              type="button"
              onClick={() => selectCity(city.code, city.name)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                form.cityCode === city.code
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'border-gray-200 text-gray-600 hover:border-emerald-400 hover:text-emerald-700'
              }`}
            >
              {city.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Check-in Date
          </label>
          <input
            type="date"
            min={today}
            value={form.checkInDate}
            onChange={(e) => set('checkInDate', e.target.value)}
            required
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Check-out Date
          </label>
          <input
            type="date"
            min={form.checkInDate || today}
            value={form.checkOutDate}
            onChange={(e) => set('checkOutDate', e.target.value)}
            required
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Guests
          </label>
          <select
            value={form.adults}
            onChange={(e) => set('adults', parseInt(e.target.value))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent bg-white"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>{n} {n === 1 ? 'Guest' : 'Guests'}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Rooms
          </label>
          <select
            value={form.rooms}
            onChange={(e) => set('rooms', parseInt(e.target.value))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent bg-white"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n} {n === 1 ? 'Room' : 'Rooms'}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white font-semibold py-3 rounded-xl transition-colors text-sm"
      >
        {loading ? 'Searching Hotels...' : 'Search Hotels'}
      </button>
    </form>
  );
}
