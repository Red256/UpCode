/**
 * US address geocoding: Nominatim (OSM) with fallbacks, then US Census one-line geocoder.
 * Nominatim usage: https://operations.osmfoundation.org/policies/nominatim/
 */

import {
  createGeocodeCache,
  nominatimSearchCacheKey,
  reverseCoordCacheKey,
  freeformAddressCacheKey,
} from "./geocodeCache";
import { throwIfRateLimited, isRateLimitedResponse } from "./httpErrors";

const isDev = import.meta.env.DEV;

const nominatimSearchCache = createGeocodeCache({ maxEntries: 700 });
const nominatimReverseCache = createGeocodeCache({ maxEntries: 600 });
const censusOneLineCache = createGeocodeCache({ maxEntries: 400 });
const freeformGeocodeCache = createGeocodeCache({ maxEntries: 350 });

/**
 * Absolute Nominatim search URL (dev: same-origin proxy so `new URL` + fetch avoid CORS).
 * @see vite.config.js server.proxy /api/nominatim
 */
export function getNominatimSearchBaseUrl() {
  if (isDev && typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api/nominatim/search`;
  }
  return "https://nominatim.openstreetmap.org/search";
}

/** Absolute Nominatim reverse URL (dev uses Vite proxy). */
export function getNominatimReverseBaseUrl() {
  if (isDev && typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api/nominatim/reverse`;
  }
  return "https://nominatim.openstreetmap.org/reverse";
}

/**
 * Cached Nominatim search (LRU + in-flight dedupe). Pass e.g. `{ q, limit: "5" }` for autocomplete.
 * @param {Record<string, string | number | undefined | null>} extraParams
 * @returns {Promise<unknown[]>}
 */
export async function nominatimSearch(extraParams) {
  const cacheKey = nominatimSearchCacheKey(extraParams);
  return nominatimSearchCache.getOrCompute(cacheKey, async () => {
    const u = new URL(getNominatimSearchBaseUrl());
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
    throwIfRateLimited(
      res,
      "Address search is rate limited. Wait a minute, then try again.",
    );
    if (!res.ok) return [];
    try {
      return await res.json();
    } catch {
      return [];
    }
  });
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
  const key = freeformAddressCacheKey(address);
  return censusOneLineCache.getOrCompute(`census1:${key}`, async () => {
    try {
      const url =
        "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=" +
        encodeURIComponent(address) +
        "&benchmark=Public_AR_Current&format=json";
      const res = await fetch(url);
      throwIfRateLimited(
        res,
        "US Census geocoder is rate limited. Wait a moment and try again.",
      );
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
  });
}

/** Minimum spacing between reverse requests (Nominatim usage policy). */
const NOMINATIM_MIN_INTERVAL_MS = 1100;

function nominatimHeaders() {
  // In dev, proxy adds User-Agent; in prod, we add it here
  const headers = {
    Accept: "application/json",
  };
  if (!isDev) {
    const id =
      (typeof import.meta !== "undefined" && import.meta.env?.VITE_NOMINATIM_CONTACT) ||
      "FranchiseFit/1.0 (see https://operations.osmfoundation.org/policies/nominatim/)";
    headers["User-Agent"] = id;
  }
  return headers;
}

let nominatimReverseChain = Promise.resolve();

/**
 * Reverse geocode a coordinate (Nominatim). Requests run strictly one-after-another + cooldown.
 * @returns {Promise<{ displayName: string, lat: number, lng: number } | null>}
 */
export function reverseGeocodeLatLng(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return Promise.resolve(null);

  const revKey = `rev:${reverseCoordCacheKey(la, ln)}`;
  const cached = nominatimReverseCache.get(revKey);
  if (cached !== undefined) return Promise.resolve(cached);

  const job = nominatimReverseChain.then(async () => {
    const hit = nominatimReverseCache.get(revKey);
    if (hit !== undefined) return hit;
    try {
      const u = new URL(getNominatimReverseBaseUrl());
      u.searchParams.set("lat", String(la));
      u.searchParams.set("lon", String(ln));
      u.searchParams.set("format", "json");
      u.searchParams.set("addressdetails", "1");
      u.searchParams.set("zoom", "18");
      const res = await fetch(u.toString(), { headers: nominatimHeaders() });
      if (isRateLimitedResponse(res)) return null;
      if (!res.ok) return null;
      const row = await res.json();
      const name = row?.display_name?.trim();
      const out = name ? { displayName: name, lat: la, lng: ln } : null;
      nominatimReverseCache.set(revKey, out);
      return out;
    } catch {
      return null;
    } finally {
      await new Promise((r) => setTimeout(r, NOMINATIM_MIN_INTERVAL_MS));
    }
  });
  nominatimReverseChain = job.catch(() => {});
  return job;
}

/**
 * Freeform US address → coordinates (Nominatim, zip, Census), with session LRU cache.
 * @param {string} address
 * @returns {Promise<{ lat: number, lng: number, displayName: string } | null>}
 */
export async function geocodeUsAddressFreeform(address) {
  const trimmed = address.trim();
  if (!trimmed) return null;

  const ffKey = `ff:${freeformAddressCacheKey(trimmed)}`;
  return freeformGeocodeCache.getOrCompute(ffKey, async () => {
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
      return await geocodeCensusOneLine(withoutLeadingNumber);
    }

    return null;
  });
}
