import { FlightOffer, HotelOffer, FlightSearchParams, HotelSearchParams } from '@/types';

const BASE = 'https://test.api.amadeus.com';
let tokenCache: { token: string; expiry: number } | null = null;

export function isConfigured(): boolean {
  return !!(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET);
}

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiry) return tokenCache.token;

  const res = await fetch(`${BASE}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_CLIENT_ID!,
      client_secret: process.env.AMADEUS_CLIENT_SECRET!,
    }),
  });

  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiry: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

function parseDuration(iso: string): string {
  return iso.replace('PT', '').replace('H', 'h ').replace('M', 'm').trim();
}

export async function searchFlights(params: FlightSearchParams): Promise<FlightOffer[]> {
  const token = await getToken();
  const query = new URLSearchParams({
    originLocationCode: params.origin.toUpperCase(),
    destinationLocationCode: params.destination.toUpperCase(),
    departureDate: params.departureDate,
    adults: String(params.adults),
    travelClass: params.travelClass,
    max: '10',
    currencyCode: 'USD',
  });
  if (params.returnDate) query.set('returnDate', params.returnDate);

  const res = await fetch(`${BASE}/v2/shopping/flight-offers?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.errors?.[0]?.title || `Flight search failed: ${res.status}`);
  }

  const data = await res.json();
  const offers: FlightOffer[] = (data.data || []).map((offer: any) => {
    const itinerary = offer.itineraries[0];
    const returnItinerary = offer.itineraries[1];
    const firstSeg = itinerary.segments[0];
    const lastSeg = itinerary.segments[itinerary.segments.length - 1];
    const carrier = data.dictionaries?.carriers?.[firstSeg.carrierCode] || firstSeg.carrierCode;

    return {
      id: offer.id,
      segments: itinerary.segments.map((seg: any) => ({
        airline: data.dictionaries?.carriers?.[seg.carrierCode] || seg.carrierCode,
        airlineCode: seg.carrierCode,
        flightNumber: `${seg.carrierCode}${seg.number}`,
        origin: seg.departure.iataCode,
        destination: seg.arrival.iataCode,
        departureTime: seg.departure.at,
        arrivalTime: seg.arrival.at,
        duration: seg.duration,
      })),
      returnSegments: returnItinerary?.segments.map((seg: any) => ({
        airline: data.dictionaries?.carriers?.[seg.carrierCode] || seg.carrierCode,
        airlineCode: seg.carrierCode,
        flightNumber: `${seg.carrierCode}${seg.number}`,
        origin: seg.departure.iataCode,
        destination: seg.arrival.iataCode,
        departureTime: seg.departure.at,
        arrivalTime: seg.arrival.at,
        duration: seg.duration,
      })),
      totalDuration: itinerary.duration,
      stops: itinerary.segments.length - 1,
      price: parseFloat(offer.price.grandTotal),
      currency: offer.price.currency,
      cabinClass: offer.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin || params.travelClass,
      seatsAvailable: offer.numberOfBookableSeats,
    };
  });

  return offers;
}

export async function searchHotels(params: HotelSearchParams): Promise<HotelOffer[]> {
  const token = await getToken();

  const listRes = await fetch(
    `${BASE}/v1/reference-data/locations/hotels/by-city?cityCode=${params.cityCode.toUpperCase()}&radius=5&radiusUnit=KM`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listRes.ok) throw new Error(`Hotel list failed: ${listRes.status}`);
  const listData = await listRes.json();
  const hotelIds = (listData.data || []).slice(0, 20).map((h: any) => h.hotelId).join(',');
  if (!hotelIds) return [];

  const nights = Math.max(1, Math.round((new Date(params.checkOutDate).getTime() - new Date(params.checkInDate).getTime()) / 86400000));

  const offersQuery = new URLSearchParams({
    hotelIds,
    checkInDate: params.checkInDate,
    checkOutDate: params.checkOutDate,
    adults: String(params.adults),
    roomQuantity: String(params.rooms),
    currency: 'USD',
    bestRateOnly: 'true',
  });

  const offersRes = await fetch(`${BASE}/v3/shopping/hotel-offers?${offersQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!offersRes.ok) throw new Error(`Hotel offers failed: ${offersRes.status}`);
  const offersData = await offersRes.json();

  return (offersData.data || []).map((item: any) => {
    const hotel = item.hotel;
    const offer = item.offers?.[0];
    const pricePerNight = offer ? parseFloat(offer.price.total) / nights : 0;

    return {
      id: hotel.hotelId,
      name: hotel.name,
      stars: hotel.rating ? parseInt(hotel.rating) : 3,
      rating: undefined,
      reviewCount: undefined,
      address: [hotel.address?.lines?.[0], hotel.address?.cityName].filter(Boolean).join(', '),
      pricePerNight: Math.round(pricePerNight),
      totalPrice: offer ? Math.round(parseFloat(offer.price.total)) : undefined,
      currency: offer?.price?.currency || 'USD',
      amenities: hotel.amenities?.slice(0, 6).map((a: string) =>
        a.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase())
      ) || [],
    };
  }).filter((h: HotelOffer) => h.pricePerNight > 0)
    .sort((a: HotelOffer, b: HotelOffer) => a.pricePerNight - b.pricePerNight);
}
