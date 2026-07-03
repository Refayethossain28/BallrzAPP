import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  searchListings, listedCities, searchExternalListings, formatGBP,
  type ExternalListing, type ListingFilter, type ListingSort,
} from '@rentmatch/shared';
import { fetchLiveListings, trackExternalListingClick, type Listing } from '../lib/db';
import { fetchExternalForBrowse } from '../lib/demoExternal';
import { photoGradient, formatDate } from '../components/ui';

export default function Browse() {
  const { data: listings = [], isLoading } = useQuery({
    queryKey: ['listings', 'live'],
    queryFn: fetchLiveListings,
  });
  // Aggregated stock from licensed external feeds — supplementary, so it
  // renders when available and the page works identically without it.
  const { data: external } = useQuery({
    queryKey: ['listings', 'external'],
    queryFn: fetchExternalForBrowse,
  });

  const [city, setCity] = useState('');
  const [minBeds, setMinBeds] = useState('');
  const [maxRent, setMaxRent] = useState('');
  const [sort, setSort] = useState<ListingSort>('newest');

  const cities = useMemo(
    () => [...new Set([...listedCities(listings), ...(external?.listings ?? []).map((l) => l.city)])].sort(),
    [listings, external],
  );
  const results = useMemo(() => {
    const filter: ListingFilter = {
      city: city || undefined,
      minBeds: minBeds === '' ? undefined : Number(minBeds),
      maxRentPence: maxRent === '' ? undefined : Number(maxRent) * 100,
    };
    return searchListings(listings, filter, sort);
  }, [listings, city, minBeds, maxRent, sort]);
  const externalResults = useMemo(() => searchExternalListings(external?.listings ?? [], {
    city: city || undefined,
    minBeds: minBeds === '' ? undefined : Number(minBeds),
    maxRentPence: maxRent === '' ? undefined : Number(maxRent) * 100,
  }), [external, city, minBeds, maxRent]);

  return (
    <>
      <h2 className="title">Find your next home</h2>
      <p className="sub">
        {isLoading ? 'Loading…' : `${results.length} propert${results.length === 1 ? 'y' : 'ies'} available to rent`}
      </p>

      <div className="filters">
        <select value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="">All cities</option>
          {cities.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={minBeds} onChange={(e) => setMinBeds(e.target.value)}>
          <option value="">Any beds</option>
          <option value="0">Studio+</option>
          <option value="1">1+ bed</option>
          <option value="2">2+ beds</option>
          <option value="3">3+ beds</option>
        </select>
        <input type="number" inputMode="numeric" placeholder="Max £ pcm" value={maxRent}
          onChange={(e) => setMaxRent(e.target.value)} style={{ width: 120 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value as ListingSort)}>
          <option value="newest">Newest</option>
          <option value="price-asc">Price ↑</option>
          <option value="price-desc">Price ↓</option>
          <option value="beds-desc">Most beds</option>
        </select>
      </div>

      {!isLoading && results.length === 0 && externalResults.length === 0 && (
        <div className="empty"><div className="big">🏚️</div>No matches — try widening your filters.</div>
      )}
      {results.map((l) => <ListingCard key={l.id} listing={l} />)}

      {externalResults.length > 0 && (
        <>
          <div className="section-t" style={{ marginTop: results.length ? 18 : 0 }}>
            More homes from across the web
          </div>
          <p className="faint" style={{ fontSize: 11, margin: '0 0 10px' }}>
            {external?.sample && <b>Example data (demo) · </b>}
            Aggregated from partner sites and licensed feeds — tap through to enquire on the source site.
          </p>
          {externalResults.map((l) => <ExternalCard key={l.id} listing={l} />)}
        </>
      )}
    </>
  );
}

function ExternalCard({ listing: l }: { listing: ExternalListing }) {
  return (
    <a href={l.url} target="_blank" rel="noopener noreferrer" className="card"
      style={{ display: 'block', color: 'inherit' }} onClick={() => trackExternalListingClick(l)}>
      <div className="photo" style={{ background: photoGradient(l.id), height: 90 }}>
        <div className="tags">
          <span className="tag">🌐 {l.source}</span>
          {l.propertyType && <span className="tag">{l.propertyType}</span>}
          {l.furnished && <span className="tag">{l.furnished}</span>}
        </div>
      </div>
      <div className="body">
        <div className="row center" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="price">{formatGBP(l.rentPence)}<small> /month</small></div>
            <div className="addr">{l.title}</div>
            <div className="addr">{[l.area, l.city].filter(Boolean).join(', ')}{l.district ? ` · ${l.district}` : ''}</div>
          </div>
        </div>
        <div className="specs">
          <span>🛏 <b>{l.beds === 0 ? 'Studio' : l.beds}</b></span>
          {l.baths != null && <span>🛁 <b>{l.baths}</b></span>}
          <span style={{ marginLeft: 'auto' }}>View on {l.source} ↗</span>
        </div>
      </div>
    </a>
  );
}

function ListingCard({ listing: l }: { listing: Listing }) {
  return (
    <Link to={`/listing/${l.id}`} className="card" style={{ display: 'block', color: 'inherit' }}>
      <div className="photo" style={{ background: photoGradient(l.id) }}>
        <div className="tags">
          <span className="tag">{l.type}</span>
          <span className="tag">{l.furnished}</span>
          <span className="tag">EPC {l.epcRating}</span>
        </div>
      </div>
      <div className="body">
        <div className="row center" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="price">{formatGBP(l.rentPence)}<small> /month</small></div>
            <div className="addr">{l.area}, {l.city} · {l.postcode}</div>
          </div>
        </div>
        <div className="specs">
          <span>🛏 <b>{l.beds === 0 ? 'Studio' : l.beds}</b></span>
          <span>🛁 <b>{l.baths}</b></span>
          <span>📅 <b>{formatDate(l.availableFrom)}</b></span>
        </div>
      </div>
    </Link>
  );
}
