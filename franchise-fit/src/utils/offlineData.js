/**
 * Census tract/county ACS — Supabase only (no CSV or other fallbacks).
 */

import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';

const SUPABASE_ENABLED = isSupabaseConfigured;

if (SUPABASE_ENABLED) {
  console.log(
    '[OfflineData] Supabase:',
    `${(import.meta.env.VITE_SUPABASE_URL ?? '').trim().slice(0, 40)}...`,
  );
} else {
  console.warn('[OfflineData] Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY — ACS data unavailable.');
}

// Lazy-loaded US places (only when searchPlaces runs)
let usPlacesData = null;

async function getUsPlaces() {
  if (!usPlacesData) {
    const module = await import('../data/usPlaces.json');
    usPlacesData = module.default;
  }
  return usPlacesData;
}

/**
 * County ACS row for one year.
 * Returns { income, rent, homeValue, studentPopulation, countyName } or null
 */
export async function fetchCountyAcsRow(countyFips, year) {
  if (!SUPABASE_ENABLED) return null;

  try {
    const { data, error } = await supabase.rpc('ff_get_county_acs', {
      p_county_fips: countyFips,
      p_year: parseInt(year, 10),
    });

    if (error) throw error;

    if (data && data.length > 0) {
      const row = data[0];
      return {
        countyName: row.county_name || '',
        income: row.median_income,
        rent: row.median_rent,
        homeValue: row.median_home_value,
        studentPopulation: row.student_population,
      };
    }
    return null;
  } catch (err) {
    console.warn(`[Supabase] fetchCountyAcsRow ${countyFips}:`, err);
    return null;
  }
}

/**
 * County ACS history for multiple years.
 */
export async function fetchCountyAcsHistory(countyFips, years) {
  if (!SUPABASE_ENABLED) return [];

  try {
    const yearInts = years.map((y) => parseInt(y, 10));
    const { data, error } = await supabase.rpc('ff_get_county_acs_history', {
      p_county_fips: countyFips,
      p_years: yearInts,
    });

    if (error) throw error;

    return (data || []).map((row) => ({
      year: row.year,
      countyName: row.county_name || '',
      income: row.median_income,
      rent: row.median_rent,
      homeValue: row.median_home_value,
      studentPopulation: row.student_population,
    }));
  } catch (err) {
    console.warn(`[Supabase] fetchCountyAcsHistory ${countyFips}:`, err);
    return [];
  }
}

/**
 * Tract ACS history for one tract (on-demand).
 * Returns Map<year, row> or null
 */
export async function fetchTractHistoryDirect(geoid, years) {
  if (!SUPABASE_ENABLED) return null;

  try {
    const yearInts = years.map((y) => parseInt(y, 10));
    const { data, error } = await supabase.rpc('ff_get_tract_acs_history', {
      p_geoid: geoid,
      p_years: yearInts,
    });

    if (error) throw error;

    const yearMap = new Map();
    if (data) {
      for (const row of data) {
        yearMap.set(row.year, {
          income: row.income,
          rent: row.rent,
          homeValue: row.home_value,
          studentPopulation: row.student_population,
        });
      }
    }
    return yearMap;
  } catch (err) {
    console.warn(`[Supabase] fetchTractHistoryDirect ${geoid}:`, err);
    return null;
  }
}

/**
 * Batch tract ACS history.
 * Returns Map<geoid, Map<year, data>>
 */
export async function fetchTractHistoryBatch(geoids, years) {
  if (!SUPABASE_ENABLED || !geoids?.length) return new Map();

  try {
    const yearInts = years.map((y) => parseInt(y, 10));
    const { data, error } = await supabase.rpc('ff_get_tracts_acs_history_batch', {
      p_geoids: geoids,
      p_years: yearInts,
    });

    if (error) throw error;

    const result = new Map();
    if (data) {
      for (const row of data) {
        const g = row.geoid?.padStart(11, '0');
        if (!g) continue;
        if (!result.has(g)) result.set(g, new Map());
        result.get(g).set(row.year, {
          income: row.income,
          rent: row.rent,
          homeValue: row.home_value,
          studentPopulation: row.student_population,
        });
      }
    }
    return result;
  } catch (err) {
    console.warn('[Supabase] fetchTractHistoryBatch:', err);
    return new Map();
  }
}

export function countyFromGeoid(geoid) {
  if (!geoid || geoid.length < 5) return null;
  return {
    state: geoid.slice(0, 2),
    county: geoid.slice(2, 5),
  };
}

/**
 * Search US places (offline JSON — not Census ACS).
 */
export async function searchPlaces(query, limit = 10) {
  if (!query || query.length < 2) return [];

  const places = await getUsPlaces();
  const q = query.toLowerCase();
  const matches = [];

  for (const place of places) {
    if (place.n.toLowerCase().startsWith(q)) {
      matches.push({
        name: place.n,
        state: place.s,
        fullState: place.f,
        lat: place.lat,
        lng: place.lng,
        score: 100,
      });
      if (matches.length >= limit * 2) break;
    }
  }

  if (matches.length < limit) {
    for (const place of places) {
      if (place.n.toLowerCase().includes(q) && !place.n.toLowerCase().startsWith(q)) {
        matches.push({
          name: place.n,
          state: place.s,
          fullState: place.f,
          lat: place.lat,
          lng: place.lng,
          score: 50,
        });
        if (matches.length >= limit * 2) break;
      }
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.length - b.name.length;
  });

  return matches.slice(0, limit);
}

export function isSupabaseEnabled() {
  return SUPABASE_ENABLED;
}
