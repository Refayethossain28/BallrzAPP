'use client';

import { HotelOffer } from '@/types';

function Stars({ count }: { count: number }) {
  return (
    <span className="text-amber-400 text-sm">
      {'★'.repeat(Math.min(5, count))}{'☆'.repeat(Math.max(0, 5 - count))}
    </span>
  );
}

const AMENITY_ICONS: Record<string, string> = {
  'Free Wifi': '📶',
  'Pool': '🏊',
  'Gym': '💪',
  'Restaurant': '🍽️',
  'Bar': '🍸',
  'Spa': '🧖',
  'Room Service': '🛎️',
  'Parking': '🅿️',
  'Airport Shuttle': '🚌',
  'Pet Friendly': '🐾',
  'Breakfast Included': '🥐',
  'Business Center': '💼',
};

function amenityIcon(name: string) {
  for (const [key, icon] of Object.entries(AMENITY_ICONS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return icon;
  }
  return '✓';
}

export default function HotelCard({ hotel }: { hotel: HotelOffer }) {
  const ratingColor =
    (hotel.rating || 0) >= 9 ? 'bg-green-600' :
    (hotel.rating || 0) >= 8 ? 'bg-green-500' :
    (hotel.rating || 0) >= 7 ? 'bg-yellow-500' : 'bg-gray-400';

  const ratingLabel =
    (hotel.rating || 0) >= 9 ? 'Exceptional' :
    (hotel.rating || 0) >= 8 ? 'Excellent' :
    (hotel.rating || 0) >= 7 ? 'Very Good' : 'Good';

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow p-4">
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="w-full sm:w-24 h-20 sm:h-24 rounded-lg bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center flex-shrink-0 text-4xl">
          🏨
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-bold text-gray-900 text-base leading-tight">{hotel.name}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <Stars count={hotel.stars} />
                {hotel.rating && (
                  <span className={`text-xs text-white font-bold px-1.5 py-0.5 rounded ${ratingColor}`}>
                    {hotel.rating}
                  </span>
                )}
                {hotel.rating && (
                  <span className="text-xs text-gray-500">{ratingLabel}</span>
                )}
                {hotel.reviewCount && (
                  <span className="text-xs text-gray-400">({hotel.reviewCount.toLocaleString()} reviews)</span>
                )}
              </div>
            </div>
          </div>

          <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {hotel.address}
          </p>

          {hotel.amenities.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {hotel.amenities.slice(0, 5).map((amenity) => (
                <span key={amenity} className="text-xs bg-gray-50 text-gray-600 px-2 py-0.5 rounded-full border border-gray-100">
                  {amenityIcon(amenity)} {amenity}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="sm:text-right sm:border-l sm:border-gray-100 sm:pl-4 sm:min-w-[140px] flex sm:flex-col sm:items-end items-center justify-between">
          <div>
            <p className="text-2xl font-bold text-emerald-700">
              ${hotel.pricePerNight.toLocaleString()}
            </p>
            <p className="text-xs text-gray-500">per night</p>
            {hotel.totalPrice && (
              <p className="text-xs text-gray-400 mt-0.5">
                ${hotel.totalPrice.toLocaleString()} total
              </p>
            )}
          </div>
          <button className="mt-3 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors">
            Book Now
          </button>
        </div>
      </div>
    </div>
  );
}
