import { FlightOffer, HotelOffer, FlightSearchParams, HotelSearchParams } from '@/types';

const AIRLINES = [
  { name: 'Delta Air Lines', code: 'DL' },
  { name: 'American Airlines', code: 'AA' },
  { name: 'United Airlines', code: 'UA' },
  { name: 'Southwest Airlines', code: 'WN' },
  { name: 'JetBlue Airways', code: 'B6' },
  { name: 'Alaska Airlines', code: 'AS' },
  { name: 'Spirit Airlines', code: 'NK' },
  { name: 'Frontier Airlines', code: 'F9' },
];

function addHours(dateStr: string, hours: number): string {
  const d = new Date(dateStr + 'T08:00:00');
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

function formatDuration(hours: number, minutes: number): string {
  return `PT${hours}H${minutes > 0 ? minutes + 'M' : ''}`;
}

export function getMockFlights(params: FlightSearchParams): FlightOffer[] {
  const baseOffers: FlightOffer[] = [];

  for (let i = 0; i < 8; i++) {
    const airline = AIRLINES[i % AIRLINES.length];
    const durationHours = 2 + Math.floor(Math.random() * 8);
    const durationMins = [0, 15, 30, 45][Math.floor(Math.random() * 4)];
    const departureOffset = i * 2;
    const stops = i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 0;
    const basePrice = stops === 0 ? 150 : 99;
    const price = Math.round(basePrice + Math.random() * 300 + i * 20);

    const departureDT = new Date(params.departureDate + 'T' + String(6 + departureOffset).padStart(2, '0') + ':00:00').toISOString();
    const arrivalDT = new Date(new Date(departureDT).getTime() + (durationHours * 60 + durationMins) * 60000).toISOString();

    const offer: FlightOffer = {
      id: `mock-flight-${i + 1}`,
      segments: [
        {
          airline: airline.name,
          airlineCode: airline.code,
          flightNumber: `${airline.code}${100 + i * 37}`,
          origin: params.origin.toUpperCase(),
          destination: params.destination.toUpperCase(),
          departureTime: departureDT,
          arrivalTime: arrivalDT,
          duration: formatDuration(durationHours, durationMins),
        },
      ],
      totalDuration: formatDuration(durationHours, durationMins),
      stops,
      price,
      currency: 'USD',
      cabinClass: params.travelClass,
      seatsAvailable: Math.floor(Math.random() * 8) + 1,
      isDemo: true,
    };

    if (params.returnDate) {
      const retDepartureDT = new Date(params.returnDate + 'T' + String(8 + (i % 6) * 2).padStart(2, '0') + ':00:00').toISOString();
      const retArrivalDT = new Date(new Date(retDepartureDT).getTime() + (durationHours * 60 + durationMins) * 60000).toISOString();
      offer.returnSegments = [
        {
          airline: airline.name,
          airlineCode: airline.code,
          flightNumber: `${airline.code}${200 + i * 37}`,
          origin: params.destination.toUpperCase(),
          destination: params.origin.toUpperCase(),
          departureTime: retDepartureDT,
          arrivalTime: retArrivalDT,
          duration: formatDuration(durationHours, durationMins),
        },
      ];
    }

    baseOffers.push(offer);
  }

  return baseOffers.sort((a, b) => a.price - b.price);
}

const HOTEL_NAMES = [
  'Grand Hyatt', 'Marriott Downtown', 'Hilton Garden Inn', 'Westin Hotel',
  'Four Seasons', 'Sheraton Hotel', 'Holiday Inn Express', 'Courtyard by Marriott',
];

const AMENITIES_POOL = [
  'Free WiFi', 'Pool', 'Gym', 'Restaurant', 'Bar', 'Spa', 'Room Service',
  'Business Center', 'Parking', 'Airport Shuttle', 'Pet Friendly', 'Breakfast Included',
];

export function getMockHotels(params: HotelSearchParams): HotelOffer[] {
  const nights = Math.max(1, Math.round((new Date(params.checkOutDate).getTime() - new Date(params.checkInDate).getTime()) / 86400000));

  return HOTEL_NAMES.map((name, i) => {
    const stars = Math.max(2, Math.min(5, 5 - Math.floor(i / 3)));
    const pricePerNight = Math.round(60 + i * 35 + Math.random() * 80);
    const amenityCount = Math.floor(Math.random() * 4) + 3;
    const amenities = AMENITIES_POOL.slice(i % 4, (i % 4) + amenityCount);

    return {
      id: `mock-hotel-${i + 1}`,
      name: `${name} ${params.cityName || params.cityCode}`,
      stars,
      rating: Math.round((6.5 + Math.random() * 3) * 10) / 10,
      reviewCount: Math.floor(200 + Math.random() * 3000),
      address: `${100 + i * 12} Main Street, ${params.cityName || params.cityCode}`,
      pricePerNight,
      totalPrice: pricePerNight * nights,
      currency: 'USD',
      amenities,
      isDemo: true,
    };
  }).sort((a, b) => a.pricePerNight - b.pricePerNight);
}
