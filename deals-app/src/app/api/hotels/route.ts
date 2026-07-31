import { NextRequest, NextResponse } from 'next/server';
import { HotelSearchParams } from '@/types';
import { isConfigured, searchHotels } from '@/lib/amadeus';
import { getMockHotels } from '@/lib/mockData';

export async function POST(request: NextRequest) {
  try {
    const params: HotelSearchParams = await request.json();

    if (!params.cityCode || !params.checkInDate || !params.checkOutDate) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (isConfigured()) {
      const results = await searchHotels(params);
      return NextResponse.json({ results, isDemo: false });
    }

    const results = getMockHotels(params);
    return NextResponse.json({ results, isDemo: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
