import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import centroid from "@turf/centroid";
import distance from "@turf/distance";
import { point } from "@turf/helpers";
import { computeOverallFromTractScores } from "./tractOverallScore";

function milesFromCenter(lat, lng, centerLat, centerLng) {
  return distance([centerLng, centerLat], [lng, lat], { units: "miles" });
}

/**
 * Tract polygon hit-test, then nearest-centroid fallback (same scores object as map).
 */
export function scoresForLatLng(lat, lng, features) {
  if (!features?.length) return null;
  const pt = point([lng, lat]);
  for (const f of features) {
    if (!f.geometry) continue;
    try {
      if (booleanPointInPolygon(pt, f)) return f.properties?.scores ?? null;
    } catch {
      /* invalid ring */
    }
  }
  let bestScores = null;
  let bestD = Infinity;
  for (const f of features) {
    if (!f.geometry) continue;
    try {
      const c = centroid(f);
      const [clng, clat] = c.geometry.coordinates;
      const d = milesFromCenter(lat, lng, clat, clng);
      if (d < bestD) {
        bestD = d;
        bestScores = f.properties?.scores ?? null;
      }
    } catch {
      /* skip */
    }
  }
  return bestScores;
}

export function scoreAtPoint(lat, lng, features, factors) {
  const scores = scoresForLatLng(lat, lng, features);
  if (!scores) return null;
  return computeOverallFromTractScores(factors, scores);
}

function inRadius(lat, lng, centerLat, centerLng, radiusMi) {
  return milesFromCenter(lat, lng, centerLat, centerLng) <= radiusMi + 1e-6;
}

/**
 * Coarse grid inside the search circle, then coordinate ascent (gradient-descent style on -score).
 */
export function collectInRadiusGridScores(centerLat, centerLng, radiusMi, factors, features, gridN = 12) {
  const latDegPerMi = 1 / 69.0;
  const lngDegPerMi = 1 / (69.0 * Math.cos((centerLat * Math.PI) / 180));
  const latSpan = radiusMi * latDegPerMi * 2;
  const lngSpan = radiusMi * lngDegPerMi * 2;
  const out = [];

  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      const lat = centerLat - radiusMi * latDegPerMi + (i / Math.max(1, gridN - 1)) * latSpan;
      const lng = centerLng - radiusMi * lngDegPerMi + (j / Math.max(1, gridN - 1)) * lngSpan;
      if (!inRadius(lat, lng, centerLat, centerLng, radiusMi)) continue;
      const s = scoreAtPoint(lat, lng, features, factors);
      if (s == null) continue;
      out.push({ lat, lng, score: s });
    }
  }
  return out;
}

const CARDINAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function refinePoint(cur, centerLat, centerLng, radiusMi, factors, features, stepMi, latDegPerMi, lngDegPerMi) {
  let best = { ...cur };
  let improved = true;
  const dirs = stepMi < radiusMi * 0.04 ? CARDINAL : [...CARDINAL, ...DIAG];
  let guard = 0;

  while (improved && guard < 48) {
    guard += 1;
    improved = false;
    for (const [dx, dy] of dirs) {
      const nlat = best.lat + dx * stepMi * latDegPerMi;
      const nlng = best.lng + dy * stepMi * lngDegPerMi;
      if (!inRadius(nlat, nlng, centerLat, centerLng, radiusMi)) continue;
      const ns = scoreAtPoint(nlat, nlng, features, factors);
      if (ns != null && ns > best.score) {
        best = { lat: nlat, lng: nlng, score: ns };
        improved = true;
        break;
      }
    }
  }
  return best;
}

/**
 * @param {object} opts
 * @param {number} opts.centerLat
 * @param {number} opts.centerLng
 * @param {number} opts.radiusMi
 * @param {object} opts.factors
 * @param {GeoJSON.FeatureCollection} opts.tractGeoJson
 * @param {number} [opts.topN=5]
 * @param {(lat: number, lng: number) => Promise<string>} [opts.reverseGeocode]
 */
export async function suggestLocationsInRadiusGradientDescent({
  centerLat,
  centerLng,
  radiusMi,
  factors,
  tractGeoJson,
  topN = 5,
  reverseGeocode = defaultReverseGeocode,
}) {
  const features = tractGeoJson?.features ?? [];
  if (!features.length) return [];

  const latDegPerMi = 1 / 69.0;
  const lngDegPerMi = 1 / (69.0 * Math.cos((centerLat * Math.PI) / 180));

  const gridPts = collectInRadiusGridScores(centerLat, centerLng, radiusMi, factors, features, 12);
  if (!gridPts.length) return [];

  const sorted = [...gridPts].sort((a, b) => b.score - a.score);
  const seedCount = Math.min(12, Math.max(topN * 2, topN));
  const seeds = sorted.slice(0, seedCount);

  const stepFracs = [0.12, 0.06, 0.03];
  const refined = [];

  for (const seed of seeds) {
    let cur = { ...seed };
    for (const frac of stepFracs) {
      const stepMi = Math.max(0.05, radiusMi * frac);
      cur = refinePoint(cur, centerLat, centerLng, radiusMi, factors, features, stepMi, latDegPerMi, lngDegPerMi);
    }
    refined.push(cur);
  }

  const MIN_DIST_MI = Math.max(0.25, radiusMi * 0.12);
  const deduped = [];
  for (const loc of refined.sort((a, b) => b.score - a.score)) {
    const tooClose = deduped.some((existing) => {
      const d = Math.sqrt(
        Math.pow((loc.lat - existing.lat) / latDegPerMi, 2) + Math.pow((loc.lng - existing.lng) / lngDegPerMi, 2),
      );
      return d < MIN_DIST_MI;
    });
    if (!tooClose && deduped.length < topN) deduped.push(loc);
  }

  const out = [];
  for (let i = 0; i < deduped.length; i++) {
    const loc = deduped[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    let displayName = `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
    try {
      displayName = (await reverseGeocode(loc.lat, loc.lng)) || displayName;
    } catch {
      /* keep coords */
    }
    const distance = milesFromCenter(loc.lat, loc.lng, centerLat, centerLng);
    out.push({ ...loc, displayName, distance });
  }

  return out;
}

async function defaultReverseGeocode(lat, lng) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.display_name || null;
}
