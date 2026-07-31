'use client';

import { FlightOffer, FlightSegment } from '@/types';

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDuration(iso: string) {
  return iso.replace('PT', '').replace('H', 'h ').replace('M', 'm').trim();
}

function SegmentRow({ seg }: { seg: FlightSegment }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
        <span className="text-xs font-bold text-blue-700">{seg.airlineCode}</span>
      </div>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="text-center">
          <p className="text-base font-bold text-gray-900">{formatTime(seg.departureTime)}</p>
          <p className="text-xs text-gray-500 font-semibold">{seg.origin}</p>
        </div>
        <div className="flex-1 flex flex-col items-center px-2">
          <p className="text-xs text-gray-400">{formatDuration(seg.duration)}</p>
          <div className="w-full flex items-center gap-1 my-0.5">
            <div className="h-px flex-1 bg-gray-300" />
            <svg className="w-3 h-3 text-gray-400 rotate-90" fill="currentColor" viewBox="0 0 24 24">
              <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
            </svg>
            <div className="h-px flex-1 bg-gray-300" />
          </div>
          <p className="text-xs text-gray-400">{seg.flightNumber}</p>
        </div>
        <div className="text-center">
          <p className="text-base font-bold text-gray-900">{formatTime(seg.arrivalTime)}</p>
          <p className="text-xs text-gray-500 font-semibold">{seg.destination}</p>
        </div>
      </div>
    </div>
  );
}

export default function FlightCard({ flight }: { flight: FlightOffer }) {
  const mainSeg = flight.segments[0];
  const lastSeg = flight.segments[flight.segments.length - 1];

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow p-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex-1 space-y-3">
          <SegmentRow seg={flight.segments[0]} />
          {flight.stops > 0 && (
            <p className="text-xs text-amber-600 font-medium pl-11">
              {flight.stops} stop{flight.stops > 1 ? 's' : ''} — {flight.segments.slice(0, -1).map(s => s.destination).join(', ')}
            </p>
          )}

          {flight.returnSegments && flight.returnSegments.length > 0 && (
            <>
              <div className="border-t border-dashed border-gray-100 pt-3">
                <p className="text-xs text-gray-400 mb-2 pl-11">Return: {formatDate(flight.returnSegments[0].departureTime)}</p>
                <SegmentRow seg={flight.returnSegments[0]} />
              </div>
            </>
          )}
        </div>

        <div className="sm:text-right sm:border-l sm:border-gray-100 sm:pl-4 sm:min-w-[130px]">
          <div className="flex sm:flex-col sm:items-end items-center justify-between">
            <div>
              <p className="text-2xl font-bold text-blue-700">
                ${flight.price.toLocaleString()}
              </p>
              <p className="text-xs text-gray-500">per person</p>
            </div>
            <div className="flex flex-col items-end gap-1 mt-1">
              {flight.stops === 0 && (
                <span className="text-xs bg-green-50 text-green-700 font-medium px-2 py-0.5 rounded-full">
                  Nonstop
                </span>
              )}
              <span className="text-xs text-gray-400 capitalize">
                {flight.cabinClass.toLowerCase().replace('_', ' ')}
              </span>
              {flight.seatsAvailable && flight.seatsAvailable <= 5 && (
                <span className="text-xs text-red-500 font-medium">
                  {flight.seatsAvailable} left!
                </span>
              )}
            </div>
          </div>
          <button className="mt-3 w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors">
            Select
          </button>
        </div>
      </div>
    </div>
  );
}
