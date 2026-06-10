require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ── Amadeus OAuth token cache ────────────────────────────────────────────────
let amadeusToken = null;
let amadeusTokenExpiry = 0;

async function getAmadeusToken() {
  if (amadeusToken && Date.now() < amadeusTokenExpiry) return amadeusToken;

  const res = await axios.post(
    "https://test.api.amadeus.com/v1/security/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  amadeusToken = res.data.access_token;
  amadeusTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return amadeusToken;
}

// ── Flight search (Amadeus) ──────────────────────────────────────────────────
app.get("/api/flights", async (req, res) => {
  const { origin, destination, departureDate, returnDate, adults = 1, max = 10 } = req.query;

  if (!origin || !destination || !departureDate) {
    return res.status(400).json({ error: "origin, destination, and departureDate are required" });
  }

  try {
    const token = await getAmadeusToken();
    const params = {
      originLocationCode: origin.toUpperCase(),
      destinationLocationCode: destination.toUpperCase(),
      departureDate,
      adults: parseInt(adults),
      max: parseInt(max),
      currencyCode: "GBP",
    };
    if (returnDate) params.returnDate = returnDate;

    const response = await axios.get(
      "https://test.api.amadeus.com/v2/shopping/flight-offers",
      { headers: { Authorization: `Bearer ${token}` }, params }
    );

    const offers = response.data.data.map((offer) => {
      const itinerary = offer.itineraries[0];
      const firstSegment = itinerary.segments[0];
      const lastSegment = itinerary.segments[itinerary.segments.length - 1];
      return {
        id: offer.id,
        price: offer.price.total,
        currency: offer.price.currency,
        airline: firstSegment.carrierCode,
        flightNumber: `${firstSegment.carrierCode}${firstSegment.number}`,
        departure: firstSegment.departure.at,
        arrival: lastSegment.arrival.at,
        origin: firstSegment.departure.iataCode,
        destination: lastSegment.arrival.iataCode,
        stops: itinerary.segments.length - 1,
        duration: itinerary.duration,
        seatsAvailable: offer.numberOfBookableSeats,
        deepLink: `https://www.google.com/flights?q=${origin}+to+${destination}`,
      };
    });

    res.json({ results: offers, count: offers.length });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Flight search error:", detail);
    res.status(500).json({ error: "Flight search failed", detail });
  }
});

// ── Airport/city autocomplete (Amadeus) ──────────────────────────────────────
app.get("/api/locations", async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: "keyword required" });

  try {
    const token = await getAmadeusToken();
    const response = await axios.get(
      "https://test.api.amadeus.com/v1/reference-data/locations",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { keyword, subType: "CITY,AIRPORT", view: "LIGHT", page: { limit: 8 } },
      }
    );
    const locations = response.data.data.map((l) => ({
      iataCode: l.iataCode,
      name: l.name,
      cityName: l.address?.cityName,
      countryName: l.address?.countryName,
      subType: l.subType,
    }));
    res.json({ results: locations });
  } catch (err) {
    res.status(500).json({ error: "Location search failed", detail: err.response?.data || err.message });
  }
});

// ── Hotel search (Amadeus) ───────────────────────────────────────────────────
app.get("/api/hotels", async (req, res) => {
  const { cityCode, checkIn, checkOut, adults = 1, rooms = 1 } = req.query;

  if (!cityCode || !checkIn || !checkOut) {
    return res.status(400).json({ error: "cityCode, checkIn, and checkOut are required" });
  }

  try {
    const token = await getAmadeusToken();

    // Step 1: get hotel IDs in city
    const listRes = await axios.get(
      "https://test.api.amadeus.com/v1/reference-data/locations/hotels/by-city",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { cityCode: cityCode.toUpperCase(), radius: 20, radiusUnit: "KM", ratings: "3,4,5" },
      }
    );

    const hotelIds = listRes.data.data.slice(0, 20).map((h) => h.hotelId).join(",");

    // Step 2: get offers for those hotels
    const offersRes = await axios.get(
      "https://test.api.amadeus.com/v3/shopping/hotel-offers",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { hotelIds, checkInDate: checkIn, checkOutDate: checkOut, adults: parseInt(adults), roomQuantity: parseInt(rooms), currencyCode: "GBP", bestRateOnly: true },
      }
    );

    const hotels = offersRes.data.data.map((h) => {
      const offer = h.offers[0];
      return {
        hotelId: h.hotel.hotelId,
        name: h.hotel.name,
        cityCode: h.hotel.cityCode,
        rating: h.hotel.rating,
        price: offer.price.total,
        currency: offer.price.currency,
        checkIn: offer.checkInDate,
        checkOut: offer.checkOutDate,
        roomType: offer.room?.typeEstimated?.category,
        bedType: offer.room?.typeEstimated?.bedType,
        deepLink: `https://www.booking.com/searchresults.html?ss=${cityCode}&checkin=${checkIn}&checkout=${checkOut}`,
      };
    });

    hotels.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    res.json({ results: hotels, count: hotels.length });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Hotel search error:", detail);
    res.status(500).json({ error: "Hotel search failed", detail });
  }
});

// ── Holiday packages — combine cheapest flight + hotel ───────────────────────
app.get("/api/packages", async (req, res) => {
  const { origin, destination, departureDate, returnDate, adults = 1 } = req.query;

  if (!origin || !destination || !departureDate || !returnDate) {
    return res.status(400).json({ error: "origin, destination, departureDate, and returnDate are required" });
  }

  try {
    const [flightRes, hotelRes] = await Promise.allSettled([
      axios.get(`http://localhost:${PORT}/api/flights`, {
        params: { origin, destination, departureDate, returnDate, adults, max: 5 },
      }),
      axios.get(`http://localhost:${PORT}/api/hotels`, {
        params: { cityCode: destination, checkIn: departureDate, checkOut: returnDate, adults },
      }),
    ]);

    const flights = flightRes.status === "fulfilled" ? flightRes.value.data.results : [];
    const hotels = hotelRes.status === "fulfilled" ? hotelRes.value.data.results : [];

    const packages = [];
    const cheapFlights = flights.slice(0, 3);
    const cheapHotels = hotels.slice(0, 3);

    for (const flight of cheapFlights) {
      for (const hotel of cheapHotels) {
        const totalPrice = (parseFloat(flight.price) + parseFloat(hotel.price)).toFixed(2);
        packages.push({
          id: `${flight.id}-${hotel.hotelId}`,
          totalPrice,
          currency: flight.currency,
          flight,
          hotel,
          saving: null,
        });
      }
    }

    packages.sort((a, b) => parseFloat(a.totalPrice) - parseFloat(b.totalPrice));
    res.json({ results: packages.slice(0, 9), count: packages.length });
  } catch (err) {
    res.status(500).json({ error: "Package search failed", detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Travel Bot running at http://localhost:${PORT}`));
