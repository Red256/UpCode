/**
 * Supabase Postgres RPC wrappers — replace Census/TIGER/Nominatim once data + functions are loaded.
 * Expected RPC names match franchise-fit/supabase/schema.sql
 */
import { supabase } from "../lib/supabaseClient";
import { ACS_DATASET_YEAR } from "./censusConstants";

function assertConfigured() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (see .env.example)."
    );
  }
}

/**
 * Mirrors fetchAreaMetrics: tract-weighted scores + optional county projection JSON.
 * RPC: ff_analyze_area
 */
export async function rpcAnalyzeArea(lat, lng, radiusMiles, acsYear = ACS_DATASET_YEAR) {
  assertConfigured();
  const { data, error } = await supabase.rpc("ff_analyze_area", {
    p_lat: lat,
    p_lng: lng,
    p_radius_mi: radiusMiles,
    p_acs_year: acsYear,
  });
  if (error) throw error;
  return data;
}

/**
 * GeoJSON FeatureCollection + areaScoreSummary (same shape as fetchTractHeatmapGeoJson).
 * RPC: ff_heatmap_geojson
 */
export async function rpcHeatmapGeoJson(lat, lng, radiusMiles, acsYear = ACS_DATASET_YEAR) {
  assertConfigured();
  const { data, error } = await supabase.rpc("ff_heatmap_geojson", {
    p_lat: lat,
    p_lng: lng,
    p_radius_mi: radiusMiles,
    p_acs_year: acsYear,
  });
  if (error) throw error;
  return data;
}

/**
 * County ACS history + projection for PDF (replaces fetchCountyTrendForReport).
 * RPC: ff_county_trend_report
 */
export async function rpcCountyTrendReport(lng, lat, acsYear = ACS_DATASET_YEAR) {
  assertConfigured();
  const { data, error } = await supabase.rpc("ff_county_trend_report", {
    p_lng: lng,
    p_lat: lat,
    p_acs_year: acsYear,
  });
  if (error) throw error;
  return data;
}

/**
 * Tract-level ACS history rows (replaces fetchTractHistory).
 * RPC: ff_tract_acs_history
 */
export async function rpcTractAcsHistory(geoid, years) {
  assertConfigured();
  const { data, error } = await supabase.rpc("ff_tract_acs_history", {
    p_geoid: geoid,
    p_years: years,
  });
  if (error) throw error;
  return data ?? [];
}
