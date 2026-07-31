import { NextRequest, NextResponse } from 'next/server';
import { FlightSearchParams } from '@/types';
import { isConfigured, searchFlights } from '@/lib/amadeus';
import { getMockFlights } from '@/lib/mockData';

export async function POST(request: NextRequest) {
  try {
    const params: FlightSearchParams = await request.json();

    if (!params.origin || !params.destination || !params.departureDate) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (isConfigured()) {
      const results = await searchFlights(params);
      return NextResponse.json({ results, isDemo: false });
    }

    const results = getMockFlights(params);
    return NextResponse.json({ results, isDemo: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
