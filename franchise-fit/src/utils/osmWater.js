/**
 * OpenStreetMap water polygons (Overpass) for masking scores on water.
 * Cached per bbox; fails open to empty collection on network/parse errors.
 *
 * Mask polygons: ≥ {@link LARGE_WATER_MASK_MIN_SQ_M}, or OSM {@link NATURAL_BAY} (estuaries /
 * SF Bay–scale fragments that are below the area cutoff each). Small ponds stay visible.
 */

import osmtogeojson from "osmtogeojson";
import area from "@turf/area";
import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import centroid from "@turf/centroid";
import circle from "@turf/circle";
import { point } from "@turf/helpers";

const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK = "https://overpass.kumi.systems/api/interpreter";

const promiseCache = new Map();

/**
 * ~3000 km² — Great Lakes / ocean-scale fragments; excludes most inland lakes.
 * Pass `{ minAreaSqM: 0 }` to {@link lngLatInWater} to treat any OSM water polygon as inside-water.
 */
export const LARGE_WATER_MASK_MIN_SQ_M = 3000 * 1e6;

/** OSM `natural=bay` — always participates in masking (covers SF Bay pieces under {@link LARGE_WATER_MASK_MIN_SQ_M}). */
export const NATURAL_BAY = "bay";

function polygonCountsAsMaskWater(featurePolygon, areaSqM, minAreaSqM) {
  const p = featurePolygon.properties || {};
  if (p.natural === NATURAL_BAY) return true;
  if (minAreaSqM <= 0) return true;
  return areaSqM >= minAreaSqM;
}

/** @param {ReturnType<typeof prepWaterIndex>} index */
function lngLatInWaterImpl(lng, lat, index, minAreaSqM) {
  if (!index?.length) return false;
  const pt = point([lng, lat]);
  for (const { f, b, areaSqM } of index) {
    if (!polygonCountsAsMaskWater(f, areaSqM, minAreaSqM)) continue;
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
    try {
      if (booleanPointInPolygon(pt, f)) return true;
    } catch {
      /* invalid geometry */
    }
  }
  return false;
}

function waterIndexCandidatesForBbox(index, tb) {
  return index.filter(({ b }) => !(b[2] < tb[0] || b[0] > tb[2] || b[3] < tb[1] || b[1] > tb[3]));
}

/**
 * Fraction of grid samples inside the tract that fall on mask-eligible water (0…1).
 */
export function tractWaterCoverageFraction(feature, waterIndex, options = {}) {
  const minAreaSqM =
    options.minAreaSqM !== undefined ? options.minAreaSqM : LARGE_WATER_MASK_MIN_SQ_M;
  const gridN = options.sampleGrid ?? 6;
  if (!waterIndex?.length) return 0;
  let tb;
  try {
    tb = bbox(feature);
  } catch {
    return 0;
  }
  const candidates = waterIndexCandidatesForBbox(waterIndex, tb);
  if (!candidates.length) return 0;

  const n = Math.max(2, Math.floor(gridN));
  let inside = 0;
  let wet = 0;
  const dx = (tb[2] - tb[0]) / (n - 1);
  const dy = (tb[3] - tb[1]) / (n - 1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = tb[0] + dx * i;
      const y = tb[1] + dy * j;
      try {
        if (!booleanPointInPolygon(point([x, y]), feature)) continue;
        inside += 1;
        if (lngLatInWaterImpl(x, y, candidates, minAreaSqM)) wet += 1;
      } catch {
        /* skip sample */
      }
    }
  }
  if (inside === 0) return 0;
  return wet / inside;
}

function tractRepresentativeLngLat(feature) {
  const pre = feature.properties?.centroid;
  if (pre?.lat != null && pre?.lng != null) return [pre.lng, pre.lat];
  try {
    return centroid(feature).geometry.coordinates;
  } catch {
    return [0, 0];
  }
}

/**
 * Choropleth / hit-testing: hide tracts that are mostly bay/open water even when the
 * tract centroid sits on shoreline infrastructure (SF Bay edge).
 */
export function tractShouldMaskWater(feature, waterIndex, options = {}) {
  if (!waterIndex?.length) return false;
  const minAreaSqM =
    options.minAreaSqM !== undefined ? options.minAreaSqM : LARGE_WATER_MASK_MIN_SQ_M;
  const [lng, lat] = tractRepresentativeLngLat(feature);
  if (lngLatInWaterImpl(lng, lat, waterIndex, minAreaSqM)) return true;
  const frac = tractWaterCoverageFraction(feature, waterIndex, { ...options, minAreaSqM });
  const thr = options.sampleThreshold ?? 0.36;
  return frac >= thr;
}

function cacheKey(south, west, north, east) {
  return [south.toFixed(4), west.toFixed(4), north.toFixed(4), east.toFixed(4)].join(",");
}

/** Client cap: Overpass uses [timeout:25]; abort the browser request if it stalls (avoids a blank map forever). */
const OVERPASS_FETCH_MS = 32_000;

async function postOverpass(url, query) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), OVERPASS_FETCH_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(tid);
  }
}

/** Bbox around the analysis circle (pad slightly past tract + kriging extent). */
export function analysisRingBbox(centerLat, centerLng, radiusMi, pad = 1.12) {
  const r = Math.max(0.25, Number(radiusMi) || 1) * pad;
  const c = circle([centerLng, centerLat], r, { units: "miles", steps: 48 });
  const [w, s, e, n] = bbox(c);
  return { south: s, west: w, north: n, east: e };
}

/**
 * @returns {Promise<import('geojson').FeatureCollection>}
 */
export function fetchWaterPolygonsForBounds(south, west, north, east) {
  const key = cacheKey(south, west, north, east);
  if (promiseCache.has(key)) return promiseCache.get(key);

  const query = `[out:json][timeout:25];
(
  nwr["natural"="water"](${south},${west},${north},${east});
  nwr["natural"="bay"](${south},${west},${north},${east});
  nwr["water"="lake"](${south},${west},${north},${east});
  way["waterway"="riverbank"](${south},${west},${north},${east});
);
out geom;`;

  const p = (async () => {
    let json;
    try {
      json = await postOverpass(OVERPASS_PRIMARY, query);
    } catch {
      try {
        json = await postOverpass(OVERPASS_FALLBACK, query);
      } catch {
        return { type: "FeatureCollection", features: [] };
      }
    }
    let fc;
    try {
      fc = osmtogeojson(json);
    } catch {
      return { type: "FeatureCollection", features: [] };
    }
    if (!fc || fc.type !== "FeatureCollection") {
      return { type: "FeatureCollection", features: [] };
    }
    fc.features = (fc.features ?? []).filter(
      (f) =>
        f?.geometry &&
        (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"),
    );
    return fc;
  })();

  promiseCache.set(key, p);
  return p;
}

/** @param {import('geojson').FeatureCollection | null | undefined} fc */
export function prepWaterIndex(fc) {
  const features = fc?.features ?? [];
  const out = [];
  for (const f of features) {
    if (!f?.geometry) continue;
    const t = f.geometry.type;
    if (t !== "Polygon" && t !== "MultiPolygon") continue;
    try {
      let areaSqM = 0;
      try {
        areaSqM = area(f);
      } catch {
        areaSqM = 0;
      }
      out.push({ f, b: bbox(f), areaSqM });
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

/**
 * @param {ReturnType<typeof prepWaterIndex>} index
 * @param {{ minAreaSqM?: number }} [options] — defaults to bay polygons + water bodies ≥ {@link LARGE_WATER_MASK_MIN_SQ_M}; use `0` for “any water”.
 */
export function lngLatInWater(lng, lat, index, options = {}) {
  const minAreaSqM =
    options.minAreaSqM !== undefined ? options.minAreaSqM : LARGE_WATER_MASK_MIN_SQ_M;
  return lngLatInWaterImpl(lng, lat, index, minAreaSqM);
}
