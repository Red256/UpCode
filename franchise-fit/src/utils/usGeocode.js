/**
 * US address geocoding: Nominatim (OSM) with fallbacks, then US Census one-line geocoder.
 * Nominatim usage: https://operations.osmfoundation.org/policies/nominatim/
 */

const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";

async function nominatimSearch(extraParams) {
  console.count("nominatimSearch");
  const u = new URL(NOMINATIM_SEARCH);
  u.searchParams.set("format", "json");
  u.searchParams.set("limit", "8");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("countrycodes", "us");
  for (const [k, v] of Object.entries(extraParams)) {
    if (v != null && String(v).trim() !== "") u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString(), {
    headers: nominatimHeaders(),
  });
  if (!res.ok) return [];
  try {
    return await res.json();
  } catch {
    return [];
  }
}

function pickNominatimFirst(data) {
  if (!data?.length) return null;
  const row = data[0];
  return {
    lat: parseFloat(row.lat),
    lng: parseFloat(row.lon),
    displayName: row.display_name,
  };
}

/**
 * Census Geocoder — strong on US street addresses; works when OSM has gaps.
 * @see https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
 */
async function geocodeCensusOneLine(address) {
  try {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=" +
      encodeURIComponent(address) +
      "&benchmark=Public_AR_Current&format=json";
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const matches = json.result?.addressMatches;
    if (!matches?.length) return null;
    const m = matches[0];
    const lat = m.coordinates?.y;
    const lng = m.coordinates?.x;
    if (lat == null || lng == null) return null;
    return {
      lat: Number(lat),
      lng: Number(lng),
      displayName: m.matchedAddress || address,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} address
 * @returns {Promise<{ lat: number, lng: number, displayName: string } | null>}
 */
const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";

/** Minimum spacing between reverse requests (Nominatim usage policy). */
const NOMINATIM_MIN_INTERVAL_MS = 1100;

function nominatimHeaders() {
  const id =
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_NOMINATIM_CONTACT) ||
    "FranchiseFit/1.0 (local dev; see https://operations.osmfoundation.org/policies/nominatim/)";
  return {
    Accept: "application/json",
    "User-Agent": id,
  };
}

let nominatimReverseChain = Promise.resolve();

/**
 * Reverse geocode a coordinate (Nominatim). Requests run strictly one-after-another + cooldown.
 * @returns {Promise<{ displayName: string, lat: number, lng: number } | null>}
 */
export function reverseGeocodeLatLng(lat, lng) {
  console.count("reverseGeocodeLatLng");
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return Promise.resolve(null);

  const job = nominatimReverseChain.then(async () => {
    try {
      const u = new URL(NOMINATIM_REVERSE);
      u.searchParams.set("lat", String(la));
      u.searchParams.set("lon", String(ln));
      u.searchParams.set("format", "json");
      u.searchParams.set("addressdetails", "1");
      u.searchParams.set("zoom", "18");
      const res = await fetch(u.toString(), { headers: nominatimHeaders() });
      if (!res.ok) return null;
      const row = await res.json();
      const name = row?.display_name?.trim();
      if (!name) return null;
      return { displayName: name, lat: la, lng: ln };
    } catch {
      return null;
    } finally {
      await new Promise((r) => setTimeout(r, NOMINATIM_MIN_INTERVAL_MS));
    }
  });
  nominatimReverseChain = job.catch(() => {});
  return job;
}

export async function geocodeUsAddressFreeform(address) {
  const trimmed = address.trim();
  if (!trimmed) return null;

  const attempts = [];
  attempts.push(trimmed);
  const withoutLeadingNumber = trimmed.replace(/^\d+\s*,\s*/u, "").trim();
  if (withoutLeadingNumber && withoutLeadingNumber !== trimmed) attempts.push(withoutLeadingNumber);

  const seen = new Set();
  for (const q of attempts) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const data = await nominatimSearch({ q });
    const hit = pickNominatimFirst(data);
    if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) return hit;
  }

  const zipMatch = trimmed.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zipMatch) {
    const data = await nominatimSearch({ postalcode: zipMatch[1] });
    const hit = pickNominatimFirst(data);
    if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) return hit;
  }

  const census = await geocodeCensusOneLine(trimmed);
  if (census) return census;

  if (withoutLeadingNumber && withoutLeadingNumber !== trimmed) {
    return geocodeCensusOneLine(withoutLeadingNumber);
  }

  return null;
}
