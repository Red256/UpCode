/**
 * Census API utilities — area scores from ACS + tract choropleth data.
 * Analyze uses the same tract features as the map (TIGERweb + ACS), not a random county slice.
 */

import { fetchTractHeatmapGeoJson } from './tractHeatmap';
import { ACS_DATASET_YEAR, ACS_HISTORY_YEARS } from './censusConstants';

/** @deprecated use ACS_HISTORY_YEARS from censusConstants */
export const ACS_YEARS = ACS_HISTORY_YEARS;
/** Years ahead to project scores using linear trend on county-level ACS history */
const PROJECTION_YEARS_AHEAD = 3;

const ACS_VARIABLES = {
  income: 'B19013_001E',
  rent: 'B25064_001E',
  homeValue: 'B25077_001E',
  population: 'B01003_001E',
  eduTotal: 'B15003_001E',
  eduBachelors: 'B15003_022E',
  eduMasters: 'B15003_023E',
  eduProfessional: 'B15003_024E',
  eduDoctorate: 'B15003_025E',
};

const NATIONAL_BENCHMARKS = {
  income: { min: 25000, max: 150000, median: 75000 },
  rent: { min: 500, max: 2500, median: 1200 },
  homeValue: { min: 100000, max: 800000, median: 350000 },
  education: { min: 10, max: 60, median: 33 },
};

function scoreValue(value, benchmark) {
  if (value == null || Number.isNaN(value)) return 50;
  const { min, max } = benchmark;
  const clamped = Math.max(min, Math.min(max, value));
  return Math.round(((clamped - min) / (max - min)) * 100);
}

function neutralAreaMetrics(year) {
  return {
    year,
    tractCount: 0,
    metrics: { income: null, rent: null, homeValue: null, education: null },
    scores: {
      'Median Income': 50,
      'Median Rent': 50,
      'Median Home Value': 50,
      School: 50,
    },
    rawValues: {
      'Median Income': '—',
      'Median Rent': '—',
      'Median Home Value': '—',
      School: '—',
    },
    tracts: [],
    projection: null,
    dataSource: 'none',
  };
}

function metricsToScores(metrics) {
  return {
    'Median Income': scoreValue(metrics.income, NATIONAL_BENCHMARKS.income),
    'Median Rent': scoreValue(metrics.rent, NATIONAL_BENCHMARKS.rent),
    'Median Home Value': scoreValue(metrics.homeValue, NATIONAL_BENCHMARKS.homeValue),
    School: scoreValue(metrics.education, NATIONAL_BENCHMARKS.education),
  };
}

function metricsToRawValues(metrics) {
  return {
    'Median Income': metrics.income != null ? `$${Math.round(metrics.income).toLocaleString()}` : '—',
    'Median Rent': metrics.rent != null ? `$${Math.round(metrics.rent).toLocaleString()}` : '—',
    'Median Home Value': metrics.homeValue != null ? `$${Math.round(metrics.homeValue).toLocaleString()}` : '—',
    School: metrics.education != null ? `${metrics.education.toFixed(1)}% bachelor's+` : '—',
  };
}

/** Average tract-level ACS values inside the analysis circle (same GeoJSON as the choropleth). */
function aggregateFromHeatmap(fc) {
  const feats = fc?.features || [];
  const incomes = [];
  const rents = [];
  const homes = [];
  const edus = [];

  for (const f of feats) {
    const r = f.properties?.raw;
    if (!r) continue;
    if (typeof r.income === 'number' && !Number.isNaN(r.income)) incomes.push(r.income);
    if (typeof r.rent === 'number' && !Number.isNaN(r.rent)) rents.push(r.rent);
    if (typeof r.homeValue === 'number' && !Number.isNaN(r.homeValue)) homes.push(r.homeValue);
    if (typeof r.schoolProxy === 'number' && !Number.isNaN(r.schoolProxy)) edus.push(r.schoolProxy);
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  return {
    income: mean(incomes),
    rent: mean(rents),
    homeValue: mean(homes),
    education: mean(edus),
  };
}

function hasAnyMetric(m) {
  return (
    m.income != null ||
    m.rent != null ||
    m.homeValue != null ||
    m.education != null
  );
}

/** Census Geocoder: county containing the point (for county-level fallback + trends). */
export async function geocodeCensusCounty(lng, lat) {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lng}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const c = data?.result?.geographies?.Counties?.[0];
    if (!c) return null;
    const state = String(c.STATE ?? c.STATEFP ?? '').padStart(2, '0');
    const county = String(c.COUNTY ?? c.COUNTYFP ?? '').padStart(3, '0');
    if (state.length !== 2 || county.length !== 3) return null;
    return { state, county };
  } catch {
    return null;
  }
}

/** State + county FIPS from an 11-digit tract GEOID when geocoder is unavailable. */
function countyFromTractGeoid(geoid) {
  if (!geoid) return null;
  const gid = String(geoid).replace(/\D/g, '');
  if (gid.length < 11) return null;
  return { state: gid.slice(0, 2), county: gid.slice(2, 5) };
}

function countyFromHeatmapFc(fc) {
  const feats = fc?.features || [];
  for (const f of feats) {
    const g = f.properties?.geoid;
    const c = countyFromTractGeoid(g);
    if (c) return c;
  }
  return null;
}

function parseCountyRow(headers, row) {
  const idx = (name) => headers.indexOf(name);
  const countyName = row[idx('NAME')] != null ? String(row[idx('NAME')]) : '';
  const income = Number(row[idx(ACS_VARIABLES.income)]);
  const rent = Number(row[idx(ACS_VARIABLES.rent)]);
  const homeValue = Number(row[idx(ACS_VARIABLES.homeValue)]);
  const eduTotal = Number(row[idx(ACS_VARIABLES.eduTotal)]) || 0;
  const b22 = Number(row[idx(ACS_VARIABLES.eduBachelors)]) || 0;
  const b23 = Number(row[idx(ACS_VARIABLES.eduMasters)]) || 0;
  const b24 = Number(row[idx(ACS_VARIABLES.eduProfessional)]) || 0;
  const b25 = Number(row[idx(ACS_VARIABLES.eduDoctorate)]) || 0;
  const eduPct = eduTotal > 0 && isValidNum(eduTotal) ? (100 * (b22 + b23 + b24 + b25)) / eduTotal : null;

  return {
    countyName,
    income: isValidNum(income) ? income : null,
    rent: isValidNum(rent) ? rent : null,
    homeValue: isValidNum(homeValue) ? homeValue : null,
    education: eduPct,
  };
}

/** County-level ACS (one row) — used when no tracts fall in the radius or as backup. */
async function fetchCountyMetricsRow(state, county, year) {
  const vars = [
    'NAME',
    ACS_VARIABLES.income,
    ACS_VARIABLES.rent,
    ACS_VARIABLES.homeValue,
    ACS_VARIABLES.eduTotal,
    ACS_VARIABLES.eduBachelors,
    ACS_VARIABLES.eduMasters,
    ACS_VARIABLES.eduProfessional,
    ACS_VARIABLES.eduDoctorate,
  ].join(',');

  const url = `https://api.census.gov/data/${year}/acs/acs5?get=${vars}&for=county:${county}&in=state:${state}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const headers = rows[0];
  return parseCountyRow(headers, rows[1]);
}

function linearProjectField(points, targetYear, field) {
  const pts = points
    .map((p) => ({ x: p.year, y: p[field] }))
    .filter((p) => p.y != null && !Number.isNaN(p.y));
  if (pts.length < 2) {
    if (pts.length === 1) return pts[0].y;
    return null;
  }
  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.x, 0);
  const sumY = pts.reduce((s, p) => s + p.y, 0);
  const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  let v = slope * targetYear + intercept;
  if (field === 'education') {
    return Math.min(100, Math.max(0, v));
  }
  return Math.max(0, Math.round(v));
}

/**
 * Build projected metrics at horizonYear from county-level ACS time series (linear trend).
 */
async function buildCountyProjection(state, county, horizonYear) {
  const rows = await Promise.all(
    ACS_HISTORY_YEARS.map(async (y) => {
      const m = await fetchCountyMetricsRow(state, county, y);
      if (!m || !hasAnyMetric(m)) return null;
      return { year: parseInt(y, 10), ...m };
    })
  );
  const history = rows.filter(Boolean).sort((a, b) => a.year - b.year);
  if (history.length < 2) return null;

  const fields = ['income', 'rent', 'homeValue', 'education'];
  const projected = {};
  for (const f of fields) {
    projected[f] = linearProjectField(history, horizonYear, f);
  }

  return {
    horizonYear,
    metrics: projected,
    factorScores: metricsToScores(projected),
    rawValues: metricsToRawValues(projected),
    source: 'county_acs_trend',
    historyYears: history.map((h) => h.year).sort((a, b) => a - b),
  };
}

/**
 * County-level ACS history + projection for PDF / exports (geocoded point).
 */
export async function fetchCountyTrendForReport(lng, lat) {
  const geo = await geocodeCensusCounty(lng, lat);
  if (!geo) return null;

  const historyRows = await Promise.all(
    ACS_HISTORY_YEARS.map(async (y) => {
      const m = await fetchCountyMetricsRow(geo.state, geo.county, y);
      if (!m || !hasAnyMetric(m)) return null;
      return {
        year: parseInt(y, 10),
        countyName: m.countyName,
        income: m.income,
        rent: m.rent,
        homeValue: m.homeValue,
        education: m.education,
      };
    })
  );
  const history = historyRows.filter(Boolean).sort((a, b) => a.year - b.year);
  if (history.length === 0) return null;

  const countyName =
    history.find((h) => h.countyName)?.countyName || `County ${geo.county}`;
  const horizonYear = parseInt(ACS_DATASET_YEAR, 10) + PROJECTION_YEARS_AHEAD;
  const projection = await buildCountyProjection(geo.state, geo.county, horizonYear);

  return {
    countyName,
    stateFips: geo.state,
    countyFips: geo.county,
    history,
    projection,
    acsDatasetYear: ACS_DATASET_YEAR,
    horizonYear,
  };
}

export async function fetchAreaMetrics(lat, lng, radiusMiles, year = ACS_DATASET_YEAR) {
  let dataSource = 'tract';
  let tractCount = 0;

  let fc = { type: 'FeatureCollection', features: [] };
  try {
    fc = await fetchTractHeatmapGeoJson(lat, lng, radiusMiles);
  } catch {
    /* fall through to county */
  }

  tractCount = fc?.features?.length ?? 0;
  let metrics = aggregateFromHeatmap(fc);

  if (!hasAnyMetric(metrics)) {
    const geo = await geocodeCensusCounty(lng, lat);
    if (geo) {
      const countyMetrics = await fetchCountyMetricsRow(geo.state, geo.county, year);
      if (countyMetrics && hasAnyMetric(countyMetrics)) {
        metrics = countyMetrics;
        dataSource = 'county';
        tractCount = 0;
      }
    }
  }

  if (!hasAnyMetric(metrics)) {
    return neutralAreaMetrics(year);
  }

  const scores = metricsToScores(metrics);
  const rawValues = metricsToRawValues(metrics);

  const geoForTrend =
    (await geocodeCensusCounty(lng, lat)) ?? countyFromHeatmapFc(fc);
  let projection = null;
  if (geoForTrend) {
    const horizonYear = parseInt(year, 10) + PROJECTION_YEARS_AHEAD;
    projection = await buildCountyProjection(geoForTrend.state, geoForTrend.county, horizonYear);
  }

  return {
    year,
    tractCount,
    metrics,
    scores,
    rawValues,
    tracts: [],
    projection,
    dataSource,
  };
}

export async function fetchTractHistory(geoid, years = ACS_YEARS) {
  const state = geoid.slice(0, 2);
  const county = geoid.slice(2, 5);
  const tract = geoid.slice(5, 11);

  const vars = Object.values(ACS_VARIABLES).join(',');
  const history = [];

  for (const year of years) {
    try {
      const url = `https://api.census.gov/data/${year}/acs/acs5?get=${vars},NAME&for=tract:${tract}&in=state:${state}&in=county:${county}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length < 2) continue;

      const headers = rows[0];
      const row = rows[1];
      const idx = (name) => headers.indexOf(name);

      const income = Number(row[idx(ACS_VARIABLES.income)]);
      const rent = Number(row[idx(ACS_VARIABLES.rent)]);
      const homeValue = Number(row[idx(ACS_VARIABLES.homeValue)]);
      const eduTotal = Number(row[idx(ACS_VARIABLES.eduTotal)]) || 0;
      const eduBach =
        (Number(row[idx(ACS_VARIABLES.eduBachelors)]) || 0) +
        (Number(row[idx(ACS_VARIABLES.eduMasters)]) || 0) +
        (Number(row[idx(ACS_VARIABLES.eduProfessional)]) || 0) +
        (Number(row[idx(ACS_VARIABLES.eduDoctorate)]) || 0);
      const eduPct = eduTotal > 0 ? (eduBach / eduTotal) * 100 : null;

      history.push({
        year: parseInt(year, 10),
        income: isValidNum(income) ? income : null,
        rent: isValidNum(rent) ? rent : null,
        homeValue: isValidNum(homeValue) ? homeValue : null,
        education: eduPct,
      });
    } catch {
      /* skip year */
    }
  }

  history.sort((a, b) => a.year - b.year);
  return history;
}

export function projectFuture(history, yearsAhead = 3) {
  if (!history.length) return [];

  const project = (field) => {
    const points = history.filter((h) => h[field] != null).map((h) => ({ x: h.year, y: h[field] }));
    if (points.length < 2) return null;

    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return null;

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    return (yr) => Math.max(0, Math.round(slope * yr + intercept));
  };

  const incomeProj = project('income');
  const rentProj = project('rent');
  const homeProj = project('homeValue');
  const eduProj = project('education');

  const lastYear = Math.max(...history.map((h) => h.year));
  const projections = [];

  for (let i = 1; i <= yearsAhead; i++) {
    const y = lastYear + i;
    projections.push({
      year: y,
      projected: true,
      income: incomeProj ? incomeProj(y) : null,
      rent: rentProj ? rentProj(y) : null,
      homeValue: homeProj ? homeProj(y) : null,
      education: eduProj ? Math.min(100, eduProj(y)) : null,
    });
  }

  return projections;
}

function isValidNum(v) {
  if (v == null) return false;
  const n = Number(v);
  return !Number.isNaN(n) && n > 0 && n !== -666666666;
}

export { NATIONAL_BENCHMARKS };
