/**
 * Tract heatmap — Census tract polygons + ACS 5-year values.
 * Primary geometry: TIGERweb MapServer spatial query on the analysis envelope (reliable for SF and all US).
 */

import circle from '@turf/circle';
import bbox from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import centroid from '@turf/centroid';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { ACS_DATASET_YEAR } from './censusConstants';
const CENSUS_MISSING = -666666666;

/**
 * ACS 2024 tracts (layer 7) and ACS 2025 tracts (layer 4) — same field set.
 * Do NOT request STATEFP/COUNTYFP/TRACTCE/AFFGEOID: those fields are not on these layers and ArcGIS returns HTTP 400.
 */
const TIGER_OUT_FIELDS = 'STATE,COUNTY,TRACT,NAME,GEOID';

const TIGER_TRACT_LAYERS = [
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/7/query',
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/4/query',
];

export const HEATMAP_METRICS = [
  { key: 'Median Income', field: 'income' },
  { key: 'Median Rent', field: 'rent' },
  { key: 'Median Home Value', field: 'homeValue' },
  { key: 'School', field: 'schoolProxy' },
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

function isValidCensusNum(v) {
  if (v == null || v === '') return false;
  const n = Number(v);
  return !Number.isNaN(n) && n !== CENSUS_MISSING && n > 0;
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

    const res = await fetch(`${layerUrl}?${params.toString()}`);
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
}

function normalizeGeoidFromFeature(f) {
  const p = f.properties || {};
  let geoid = p.GEOID || p.GEO_ID;
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

export async function fetchTractHeatmapGeoJson(centerLat, centerLng, radiusMiles) {
  if (!isUsApprox(centerLat, centerLng)) {
    throw new Error('Tract heatmap is only available for locations in the United States.');
  }

  const analysisCircle = circle([centerLng, centerLat], radiusMiles, { units: 'miles', steps: 96 });
  const { xmin, ymin, xmax, ymax } = bboxEnvelopeFromCircle(centerLat, centerLng, radiusMiles, 1.08);

  let features = [];
  for (const layerUrl of TIGER_TRACT_LAYERS) {
    try {
      features = await fetchTigerTractsIntersectingEnvelope(layerUrl, xmin, ymin, xmax, ymax);
      if (features.length) break;
    } catch {
      /* try next layer */
    }
  }

  if (!features.length) {
    return { type: 'FeatureCollection', features: [] };
  }

  const intersectsCircle = (f) => {
    if (!f.geometry) return false;
    try {
      if (booleanIntersects(f, analysisCircle)) return true;
    } catch {
      /* invalid rings */
    }
    try {
      const c = centroid(f);
      return booleanPointInPolygon(c, analysisCircle);
    } catch {
      return false;
    }
  };

  let filtered = features.filter(intersectsCircle);
  if (!filtered.length && features.length) {
    filtered = [...features];
  }

  const byCounty = new Map();
  for (const f of filtered) {
    normalizeGeoidFromFeature(f);
    const p = f.properties || {};
    const st = p.STATE;
    const co = p.COUNTY;
    if (st == null || co == null) continue;
    const ckey = `${String(st).padStart(2, '0')}_${padCounty(co)}`;
    if (!byCounty.has(ckey)) byCounty.set(ckey, []);
    byCounty.get(ckey).push(f);
  }

  const acsVars = [
    'NAME',
    'B19013_001E',
    'B25064_001E',
    'B25077_001E',
    'B15003_001E',
    'B15003_022E',
    'B15003_023E',
    'B15003_024E',
    'B15003_025E',
  ].join(',');

  const acsByGeoid = new Map();

  for (const [key] of byCounty) {
    const [state, county] = key.split('_');
    const url = `https://api.census.gov/data/${ACS_DATASET_YEAR}/acs/acs5?get=${acsVars}&for=tract:*&in=state:${state}&in=county:${county}`;
    try {
      const acsRes = await fetch(url);
      if (!acsRes.ok) continue;
      const rows = await acsRes.json();
      if (!Array.isArray(rows) || rows.length < 2) continue;

      const headers = rows[0];
      const idx = (name) => headers.indexOf(name);

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const tract = row[idx('tract')];
        if (tract == null) continue;
        const geoid = buildGeoid(state, county, tract);
        acsByGeoid.set(geoid, { headers, row });
      }
    } catch {
      /* skip county */
    }
  }

  const incomeRaw = [];
  const rentRaw = [];
  const homeRaw = [];
  const schoolRaw = [];

  for (const f of filtered) {
    const gid = f.properties.geoid;
    const pack = gid ? acsByGeoid.get(gid) : null;

    if (pack) {
      const { headers, row } = pack;
      const idx = (name) => headers.indexOf(name);

      const income = row[idx('B19013_001E')];
      const rent = row[idx('B25064_001E')];
      const home = row[idx('B25077_001E')];
      const tot = row[idx('B15003_001E')];
      const b22 = Number(row[idx('B15003_022E')]) || 0;
      const b23 = Number(row[idx('B15003_023E')]) || 0;
      const b24 = Number(row[idx('B15003_024E')]) || 0;
      const b25 = Number(row[idx('B15003_025E')]) || 0;
      const totN = Number(tot);
      const schoolPct = isValidCensusNum(tot) && totN > 0 ? (100 * (b22 + b23 + b24 + b25)) / totN : null;

      f.properties.raw = {
        income: isValidCensusNum(income) ? Number(income) : null,
        rent: isValidCensusNum(rent) ? Number(rent) : null,
        homeValue: isValidCensusNum(home) ? Number(home) : null,
        schoolProxy: schoolPct,
        name: row[idx('NAME')] || f.properties.NAME,
      };
    } else {
      f.properties.raw = {
        income: null,
        rent: null,
        homeValue: null,
        schoolProxy: null,
        name: f.properties.NAME,
      };
    }

    const r = f.properties.raw;
    if (r.income != null) incomeRaw.push(r.income);
    if (r.rent != null) rentRaw.push(r.rent);
    if (r.homeValue != null) homeRaw.push(r.homeValue);
    if (r.schoolProxy != null) schoolRaw.push(r.schoolProxy);
  }

  const mm = (arr) => (arr.length ? { min: Math.min(...arr), max: Math.max(...arr) } : { min: 0, max: 1 });
  const mIncome = mm(incomeRaw);
  const mRent = mm(rentRaw);
  const mHome = mm(homeRaw);
  const mSchool = mm(schoolRaw);

  const toScore = (v, min, max) => {
    if (v == null || Number.isNaN(v)) return null;
    if (max === min) return 50;
    return (100 * (v - min)) / (max - min);
  };

  for (const f of filtered) {
    const r = f.properties.raw;
    f.properties.scores = {
      income: toScore(r.income, mIncome.min, mIncome.max),
      rent: toScore(r.rent, mRent.min, mRent.max),
      homeValue: toScore(r.homeValue, mHome.min, mHome.max),
      schoolProxy: toScore(r.schoolProxy, mSchool.min, mSchool.max),
    };
  }

  return { type: 'FeatureCollection', features: filtered };
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
