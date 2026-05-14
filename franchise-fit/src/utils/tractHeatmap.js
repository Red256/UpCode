/**
 * Tract heatmap — Census tract polygons + ACS 5-year values.
 * OFFLINE MODE: Uses local GeoJSON boundaries when available, falls back to TIGERweb.
 */

import circle from '@turf/circle';
import bbox from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import centroid from '@turf/centroid';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import distance from '@turf/distance';
import { throwIfRateLimited, isHttpRateLimitError } from './httpErrors';
import { scoreStudentRegion, scoreSchoolDensityHeadcount, scoreSchoolEnrollmentFallback } from './studentRegionScore';
import { circleAreaSqMi, featureAreaSqMi } from './tractAreaUnits';
/** Precomputed from tract boundary files: [minLng, minLat, maxLng, maxLat] per state FIPS */
import stateTractLayerBbox from '../data/stateTractLayerBbox.json';

/** Preloaded tract boundary GeoJSONs (scripts/downloadTractBoundaries.mjs). */
const tractBoundaryGlobs = import.meta.glob('../data/tractBoundaries/*.json');

/** State FIPS that have a local tractBoundaries/{st}.json (computed once). */
const AVAILABLE_BOUNDARY_STATES = new Set(
  Object.keys(tractBoundaryGlobs)
    .map((k) => k.match(/(\d{2})\.json$/)?.[1])
    .filter(Boolean),
);

/** Precomputed per-tract scores + raw ACS (scripts/precomputeAllTractScores.mjs). */
const tractScoreGlobs = import.meta.glob('../data/tractScores/*.json');

async function loadTractScoreLookup(stateFipsSet) {
  const merged = {};
  await Promise.all(
    [...stateFipsSet].map(async (st) => {
      const path = `../data/tractScores/${st}.json`;
      const loader = tractScoreGlobs[path];
      if (!loader) return;
      try {
        const mod = await loader();
        const data = mod.default ?? mod;
        Object.assign(merged, data);
      } catch {
        /* missing or corrupt shard */
      }
    }),
  );
  return merged;
}

/**
 * ACS 2024 tracts (layer 7) and ACS 2025 tracts (layer 4) — same field set.
 * Do NOT request STATEFP/COUNTYFP/TRACTCE/AFFGEOID: those fields are not on these layers and ArcGIS returns HTTP 400.
 */
const TIGER_OUT_FIELDS = 'STATE,COUNTY,TRACT,NAME,GEOID';

const TIGER_TRACT_LAYERS = [
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/7/query',
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/4/query',
];

/** Cache for loaded local boundaries. */
const localBoundaryCache = new Map();

/**
 * Load local tract boundaries for a set of states.
 * Returns features with geometry for tracts in the specified states.
 */
async function loadLocalBoundaries(stateFipsSet) {
  const states = [...stateFipsSet];
  const chunks = await Promise.all(
    states.map(async (st) => {
      if (localBoundaryCache.has(st)) {
        return localBoundaryCache.get(st);
      }
      const path = `../data/tractBoundaries/${st}.json`;
      const loader = tractBoundaryGlobs[path];
      if (!loader) {
        localBoundaryCache.set(st, []);
        return [];
      }
      try {
        const mod = await loader();
        const fc = mod.default ?? mod;
        const stateFeatures = fc?.features || [];
        localBoundaryCache.set(st, stateFeatures);
        return stateFeatures;
      } catch {
        localBoundaryCache.set(st, []);
        return [];
      }
    }),
  );
  return chunks.flat();
}

/**
 * States whose tract layer bbox overlaps the query envelope (avoids loading ~50 state files).
 * @param {[number,number,number,number]} env - [minLng, minLat, maxLng, maxLat]
 */
function stateFipsOverlappingEnvelope(env) {
  const [ew, es, ee, en] = env;
  const out = [];
  for (const st of AVAILABLE_BOUNDARY_STATES) {
    const bb = stateTractLayerBbox[st];
    if (!bb) continue;
    const [sw, ss, se, sn] = bb;
    if (ew <= se && ee >= sw && es <= sn && en >= ss) out.push(st);
  }
  return out;
}

/** Axis-aligned bbox overlap [minLng, minLat, maxLng, maxLat] */
function bboxOverlaps2d(a, b) {
  const [aw, as, ae, an] = a;
  const [bw, bs, be, bn] = b;
  return aw <= be && ae >= bw && as <= bn && an >= bs;
}

/** Bbox center [lng, lat] — cheaper than centroid for distance weights. */
function bboxCenterLngLat(f) {
  const b = bbox(f);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export const HEATMAP_METRICS = [
  { key: 'Median Income', field: 'income' },
  { key: 'Median Rent', field: 'rent' },
  { key: 'Median Home Value', field: 'homeValue' },
  /** Population 3+ enrolled in school (headcount) */
  { key: 'Student Density', field: 'studentPopulation' },
];

export function isUsApprox(lat, lng) {
  return lat >= 18 && lat <= 72 && lng >= -170 && lng <= -50;
}

function padCounty(c) {
  return String(c).trim().padStart(3, '0');
}

function padTract(t) {
  return String(t).trim().padStart(6, '0');
}

function buildGeoid(state, county, tract) {
  return `${String(state).padStart(2, '0')}${padCounty(county)}${padTract(tract)}`;
}

function bboxEnvelopeFromCircle(centerLat, centerLng, radiusMiles, pad = 1.05) {
  const c = circle([centerLng, centerLat], radiusMiles * pad, { units: 'miles', steps: 64 });
  const [xmin, ymin, xmax, ymax] = bbox(c);
  return { xmin, ymin, xmax, ymax };
}

/**
 * Fetch all tract features intersecting the envelope; ArcGIS may paginate (exceededTransferLimit).
 */
async function fetchTigerTractsIntersectingEnvelope(layerUrl, xmin, ymin, xmax, ymax) {
  const pageSize = 2000;
  let offset = 0;
  const all = [];
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 55_000);

  try {
    for (;;) {
      const params = new URLSearchParams({
        where: '1=1',
        geometry: `${xmin},${ymin},${xmax},${ymax}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: TIGER_OUT_FIELDS,
        returnGeometry: 'true',
        outSR: '4326',
        f: 'geojson',
        resultRecordCount: String(pageSize),
        resultOffset: String(offset),
      });

      const res = await fetch(`${layerUrl}?${params.toString()}`, { signal: ac.signal });
      throwIfRateLimited(
        res,
        'Census tract service is rate limited. Wait a minute and try again.',
      );
      if (!res.ok) return [];
      const gj = await res.json();
      const feats = gj.features || [];
      all.push(...feats);

      const exceeded =
        gj.properties?.exceededTransferLimit === true ||
        gj.exceededTransferLimit === true;

      if (!exceeded || feats.length === 0) break;
      offset += feats.length;
      if (offset > 80000) break;
    }

    return all;
  } finally {
    clearTimeout(tid);
  }
}

function normalizeGeoidFromFeature(f) {
  const p = f.properties || {};
  /** Local boundary files (downloadTractBoundaries.mjs) only store lowercase `geoid`. */
  let geoid = p.GEOID || p.GEO_ID || p.geoid;
  if (geoid != null) {
    geoid = String(geoid).replace(/^1400000US/i, '').replace(/^.*US/i, '');
    geoid = String(geoid).replace(/\D/g, '');
  }
  if (!geoid || geoid.length < 11) {
    const st = p.STATE;
    const co = p.COUNTY;
    const tr = p.TRACT;
    if (st != null && co != null && tr != null) geoid = buildGeoid(st, co, tr);
    else geoid = geoid ? geoid.slice(0, 11) : null;
  } else {
    geoid = geoid.slice(0, 11);
  }
  if (geoid && geoid.length >= 11) f.properties.geoid = geoid;
}

/**
 * @param {import('geojson').Polygon['coordinates'][0] | null} [polygonLatLng] - [[lat,lng], ...] ring
 * @param {{ onProgress?: (fc: import('geojson').FeatureCollection & { partial?: boolean; radiusMiles?: number; areaScoreSummary?: object }) => void }} [fetchOptions]
 */
export async function fetchTractHeatmapGeoJson(centerLat, centerLng, radiusMiles, polygonLatLng = null, fetchOptions = {}) {
  const { onProgress } = fetchOptions;
  if (!isUsApprox(centerLat, centerLng)) {
    throw new Error('Tract heatmap is only available for locations in the United States.');
  }

  // If polygon provided, use it; otherwise use circle
  let analysisShape;
  let shapeBbox;
  let queryEnv;
  
  if (polygonLatLng && polygonLatLng.length >= 3) {
    // Convert polygon from [lat,lng] to GeoJSON [lng,lat]
    const geoJsonCoords = polygonLatLng.map(([lat, lng]) => [lng, lat]);
    geoJsonCoords.push(geoJsonCoords[0]); // close the ring
    analysisShape = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [geoJsonCoords]
      },
      properties: {}
    };
    shapeBbox = bbox(analysisShape);
    const pad = 0.02; // small padding for envelope
    queryEnv = [
      shapeBbox[0] - pad,
      shapeBbox[1] - pad,
      shapeBbox[2] + pad,
      shapeBbox[3] + pad
    ];
  } else {
    analysisShape = circle([centerLng, centerLat], radiusMiles, { units: 'miles', steps: 96 });
    shapeBbox = bbox(analysisShape);
    const { xmin, ymin, xmax, ymax } = bboxEnvelopeFromCircle(centerLat, centerLng, radiusMiles, 1.08);
    queryEnv = [xmin, ymin, xmax, ymax];
  }

  let features = [];

  // Load only state files whose tract layer intersects the query envelope (not all ~51 states).
  const statesToLoad = stateFipsOverlappingEnvelope(queryEnv);
  const localFeatures = statesToLoad.length ? await loadLocalBoundaries(statesToLoad) : [];

  if (localFeatures.length > 0) {
    features = localFeatures.filter((f) => {
      if (!f.geometry) return false;
      try {
        const fb = bbox(f);
        const fbb = [fb[0], fb[1], fb[2], fb[3]];
        return bboxOverlaps2d(queryEnv, fbb);
      } catch {
        return false;
      }
    });
  }
  
  // If no local features, try TIGERweb API (online fallback)
  if (!features.length) {
    const [xmin, ymin, xmax, ymax] = queryEnv;
    for (let attempt = 0; attempt < 2 && !features.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 450));
      for (const layerUrl of TIGER_TRACT_LAYERS) {
        try {
          features = await fetchTigerTractsIntersectingEnvelope(layerUrl, xmin, ymin, xmax, ymax);
          if (features.length) break;
        } catch (e) {
          if (isHttpRateLimitError(e)) throw e;
        }
      }
    }
  }

  if (!features.length) {
    return { type: 'FeatureCollection', features: [], radiusMiles: Number(radiusMiles) || 0 };
  }

  const intersectsShape = (f) => {
    if (!f.geometry) return false;
    try {
      const fb = bbox(f);
      if (
        fb[0] > shapeBbox[2] ||
        fb[2] < shapeBbox[0] ||
        fb[1] > shapeBbox[3] ||
        fb[3] < shapeBbox[1]
      ) {
        return false;
      }
    } catch {
      return false;
    }
    try {
      if (booleanIntersects(f, analysisShape)) return true;
    } catch {
      /* invalid rings */
    }
    try {
      const c = centroid(f);
      return booleanPointInPolygon(c, analysisShape);
    } catch {
      return false;
    }
  };

  let filtered = features.filter(intersectsShape);
  if (!filtered.length && features.length) {
    filtered = [...features];
  }

  const stateSet = new Set();
  for (const f of filtered) {
    normalizeGeoidFromFeature(f);
    const gid = f.properties?.geoid;
    const st =
      f.properties?.STATE ??
      (gid && String(gid).length >= 2 ? String(gid).slice(0, 2) : null);
    if (st != null) stateSet.add(String(st).padStart(2, '0'));
  }

  const emptyRaw = () => ({
    income: null,
    rent: null,
    homeValue: null,
    studentPopulation: null,
    studentsEnrolled: null,
    population: null,
    name: null,
  });
  const emptyScores = () => ({
    income: null,
    rent: null,
    homeValue: null,
    studentPopulation: null,
  });

  if (onProgress && filtered.length > 0) {
    for (const f of filtered) {
      f.properties.raw = { ...emptyRaw(), name: f.properties.NAME };
      f.properties.scores = emptyScores();
    }
    // Use setTimeout to ensure the partial update is processed before continuing
    await new Promise(resolve => setTimeout(resolve, 0));
    onProgress({
      type: 'FeatureCollection',
      features: filtered,
      radiusMiles: Number(radiusMiles) || 0,
      partial: true,
      loadGen: Date.now(), // Add generation marker for React key
    });
    // Give the UI time to render the partial data
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const lookup = await loadTractScoreLookup(stateSet);

  // Process features in chunks to avoid blocking the UI
  const CHUNK_SIZE = 50;
  for (let i = 0; i < filtered.length; i += CHUNK_SIZE) {
    const chunk = filtered.slice(i, i + CHUNK_SIZE);
    for (const f of chunk) {
      const gid = f.properties.geoid;
      const entry = gid && lookup[gid] ? lookup[gid] : null;
      if (entry?.raw && entry?.scores) {
        f.properties.raw = {
          ...entry.raw,
          name: entry.raw.name || f.properties.NAME,
        };
        f.properties.scores = { ...entry.scores };
        if (entry.centroid?.lat != null && entry.centroid?.lng != null) {
          f.properties.centroid = { lat: entry.centroid.lat, lng: entry.centroid.lng };
        }
      } else {
        f.properties.raw = { ...emptyRaw(), name: f.properties.NAME };
        f.properties.scores = emptyScores();
      }
    }
    
    // Send progressive update every 2 chunks (about 100 tracts)
    if (onProgress && i > 0 && i % (CHUNK_SIZE * 2) === 0 && i + CHUNK_SIZE < filtered.length) {
      onProgress({
        type: 'FeatureCollection',
        features: filtered,
        radiusMiles: Number(radiusMiles) || 0,
        partial: true,
        loadGen: Date.now(), // Add generation marker for React key
      });
    }
    
    // Yield control to the browser every chunk
    if (i + CHUNK_SIZE < filtered.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /** Student density map score must use the same land sq mi as popups (`featureAreaSqMi`), not precompute AREA_MAP only. */
  for (const f of filtered) {
    const raw = f.properties.raw;
    const hc = raw?.studentPopulation;
    const landSqMi = featureAreaSqMi(f);
    const densScore = scoreSchoolDensityHeadcount(hc, landSqMi);
    const sch =
      densScore != null ? densScore : scoreSchoolEnrollmentFallback(hc);
    if (!f.properties.scores) f.properties.scores = emptyScores();
    f.properties.scores.studentPopulation = sch != null ? sch : null;
  }

  const R = Math.max(Number(radiusMiles) || 0, 1e-6);

  for (const f of filtered) {
    let dMi = null;
    let w = 0;
    try {
      const [lng, lat] = bboxCenterLngLat(f);
      dMi = distance([lng, lat], [centerLng, centerLat], { units: 'miles' });
      w = Math.max(0, 1 - dMi / R);
    } catch {
      dMi = null;
      w = 0;
    }
    f.properties.distanceMi = dMi;
    f.properties.distanceWeight = w;
  }

  const weightedScore = (metricKey) => {
    let num = 0;
    let den = 0;
    for (const f of filtered) {
      const w = f.properties.distanceWeight;
      if (w == null || w <= 0) continue;
      const sc = f.properties.scores?.[metricKey];
      if (sc == null || Number.isNaN(sc)) continue;
      num += w * sc;
      den += w;
    }
    return den > 0 ? num / den : null;
  };

  const weightedRawMean = (metricKey) => {
    let num = 0;
    let den = 0;
    for (const f of filtered) {
      const w = f.properties.distanceWeight;
      if (w == null || w <= 0) continue;
      const v = f.properties.raw?.[metricKey];
      if (v == null || Number.isNaN(v)) continue;
      num += w * v;
      den += w;
    }
    return den > 0 ? num / den : null;
  };

  let studentRegionTotal = 0;
  let studentRegionTractCount = 0;
  for (const f of filtered) {
    const v = f.properties.raw?.studentPopulation;
    if (v == null || Number.isNaN(v)) continue;
    studentRegionTotal += v;
    studentRegionTractCount += 1;
  }
  const studentRegionDisplay =
    studentRegionTractCount > 0 ? studentRegionTotal : null;

  const regionLandAreaSqMi = circleAreaSqMi(R);

  const areaScoreSummary = {
    factorScores: {
      'Median Income': weightedScore('income'),
      'Median Rent': weightedScore('rent'),
      'Median Home Value': weightedScore('homeValue'),
      "Student Density":
        studentRegionTractCount > 0 && regionLandAreaSqMi > 0
          ? scoreStudentRegion(studentRegionTotal, regionLandAreaSqMi)
          : null,
    },
    metricMeans: {
      income: weightedRawMean('income'),
      rent: weightedRawMean('rent'),
      homeValue: weightedRawMean('homeValue'),
      studentPopulation: studentRegionDisplay,
      studentTractCount: studentRegionTractCount > 0 ? studentRegionTractCount : null,
      studentRegionAreaSqMi: regionLandAreaSqMi > 0 ? regionLandAreaSqMi : null,
    },
  };

  for (const k of Object.keys(areaScoreSummary.factorScores)) {
    const v = areaScoreSummary.factorScores[k];
    if (v == null || Number.isNaN(v)) {
      areaScoreSummary.factorScores[k] = null;
    } else {
      areaScoreSummary.factorScores[k] = Math.round(v);
    }
  }

  return {
    type: 'FeatureCollection',
    features: filtered,
    radiusMiles: Number(radiusMiles) || 0,
    areaScoreSummary,
    loadGen: Date.now(), // Add generation marker for React key
  };
}

/**
 * Choropleth: low score → red, high score → green (strict red–yellow–green spectrum; no blue).
 * Uses HSL hue 0° (red) → 120° (green); missing data stays neutral gray.
 */
export function colorForHeatmapScore(score) {
  if (score == null || Number.isNaN(score)) return '#94a3b8';
  const s = Math.max(0, Math.min(100, score));
  const t = s / 100;
  const h = Math.round(120 * t);
  return `hsl(${h}, 72%, 44%)`;
}
