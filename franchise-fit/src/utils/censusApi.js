/**
 * Census API utilities — area scores from ACS + tract choropleth data.
 * Hybrid mode: Uses online geocoding/autocomplete but offline Census data.
 */

import { fetchTractHeatmapGeoJson } from './tractHeatmap';
import { ACS_DATASET_YEAR, ACS_HISTORY_YEARS, formatMedianHomeValueDisplay } from './censusConstants';
import { fetchCountyAcsRow } from './offlineData';
import nationalTractZStats from '../data/nationalTractZStats.json';
import { scoreStudentRegion } from './studentRegionScore';
import { circleAreaSqMi } from './tractAreaUnits';

/** @deprecated use ACS_HISTORY_YEARS from censusConstants */
export const ACS_YEARS = ACS_HISTORY_YEARS;
/** Years ahead for area projection (tract-aggregate linear trend on ACS history). */
const PROJECTION_YEARS_AHEAD = 3;

// ACS_VARIABLES removed - using offline data

/** Fallback benchmarks when z-stats unavailable */
const FALLBACK_BENCHMARKS = {
  income: { min: 25000, max: 150000, median: 75000 },
  rent: { min: 500, max: 2500, median: 1200 },
  homeValue: { min: 100000, max: 800000, median: 350000 },
  studentPopulation: { min: 100, max: 5000, median: 1500 },
};

/** Convert z-score to 0-100 score (z=0 → 50, z=+2 → 100, z=-2 → 0) */
function zToScore(z) {
  if (z == null || Number.isNaN(z)) return 50;
  const s = 50 + 25 * z;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function scoreValueFromZStats(value, metricKey) {
  if (value == null || Number.isNaN(value)) return 50;

  const stats = nationalTractZStats[metricKey];
  const median = stats?.median ?? stats?.mu;
  if (!stats || median == null || stats.sigma == null || stats.sigma <= 0) {
    // Fallback to min/max if z-stats unavailable
    const benchmark = FALLBACK_BENCHMARKS[metricKey];
    if (!benchmark) return 50;
    const { min, max } = benchmark;
    const clamped = Math.max(min, Math.min(max, value));
    return Math.round(((clamped - min) / (max - min)) * 100);
  }

  const z = (value - median) / stats.sigma;
  return zToScore(z);
}

function neutralAreaMetrics(year) {
  return {
    year,
    tractCount: 0,
    metrics: {
      income: null,
      rent: null,
      homeValue: null,
      studentPopulation: null,
      studentTractCount: null,
      studentRegionAreaSqMi: null,
    },
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
    tractGeoJson: { type: 'FeatureCollection', features: [] },
  };
}

function metricsToScores(metrics) {
  const school =
    metrics.studentPopulation != null &&
    metrics.studentRegionAreaSqMi != null &&
    metrics.studentRegionAreaSqMi > 0
      ? scoreStudentRegion(metrics.studentPopulation, metrics.studentRegionAreaSqMi)
      : 50;

  return {
    'Median Income': scoreValueFromZStats(metrics.income, 'income'),
    'Median Rent': scoreValueFromZStats(metrics.rent, 'rent'),
    'Median Home Value': scoreValueFromZStats(metrics.homeValue, 'homeValue'),
    School: school,
  };
}

function metricsToRawValues(metrics) {
  return {
    'Median Income': metrics.income != null ? `$${Math.round(metrics.income).toLocaleString()}` : '—',
    'Median Rent': metrics.rent != null ? `$${Math.round(metrics.rent).toLocaleString()}` : '—',
    'Median Home Value':
      metrics.homeValue != null ? formatMedianHomeValueDisplay(metrics.homeValue) : '—',
    School:
      metrics.studentPopulation != null &&
      metrics.studentRegionAreaSqMi != null &&
      metrics.studentRegionAreaSqMi > 0
        ? `${(metrics.studentPopulation / metrics.studentRegionAreaSqMi).toLocaleString('en-US', {
            maximumFractionDigits: 1,
            minimumFractionDigits: 0,
          })} students/sq mi`
        : '—',
  };
}

function coalesceFactorScore(v) {
  if (v == null || Number.isNaN(Number(v))) return 50;
  return Number(v);
}

/**
 * Tract heatmap attaches `areaScoreSummary`: z-score-based 0–100 factor scores per tract,
 * distance-weighted to area means. Raw `metricMeans` use the same distance weights.
 */
function aggregateFromHeatmap(fc, radiusMiles) {
  if (fc.areaScoreSummary?.metricMeans && fc.areaScoreSummary?.factorScores) {
    return {
      metrics: fc.areaScoreSummary.metricMeans,
      factorScoresOverride: fc.areaScoreSummary.factorScores,
    };
  }

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
    if (typeof r.studentPopulation === 'number' && !Number.isNaN(r.studentPopulation)) {
      edus.push(r.studentPopulation);
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const k = edus.length;
  const studentTotal = k ? edus.reduce((a, b) => a + b, 0) : null;
  const rMi = fc?.radiusMiles ?? radiusMiles;
  const regionAreaSqMi = circleAreaSqMi(rMi);

  return {
    metrics: {
      income: mean(incomes),
      rent: mean(rents),
      homeValue: mean(homes),
      studentPopulation: studentTotal,
      studentTractCount: k > 0 ? k : null,
      studentRegionAreaSqMi: regionAreaSqMi > 0 ? regionAreaSqMi : null,
    },
    factorScoresOverride: null,
  };
}

function hasAnyMetric(m) {
  return (
    m.income != null ||
    m.rent != null ||
    m.homeValue != null ||
    m.studentPopulation != null
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

// parseCountyRow removed - using offline data loader

/** County-level ACS row (Supabase or CSV). */
async function fetchCountyMetricsRow(state, county, year) {
  const countyFips = `${state}${county}`;
  return fetchCountyAcsRow(countyFips, year);
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
  
  // Cap unrealistic growth for student population (county-level: typically 1k-200k)
  if (field === 'studentPopulation') {
    const lastY = pts[pts.length - 1].y;
    const avgY = sumY / n;
    const yearsAhead = targetYear - pts[pts.length - 1].x;
    // Cap at 2x average or last value + 30% per year
    const maxReasonable = Math.max(avgY * 2, lastY * Math.pow(1.3, yearsAhead));
    v = Math.min(v, maxReasonable);
  }
  
  // Return null if projection is negative (invalid)
  if (v < 0) return null;
  return Math.round(v);
}

/**
 * Build projected metrics at horizonYear from county-level ACS time series (linear trend).
 * NOTE: County student population (sum of all tracts) is omitted as it's not useful for site selection.
 */
async function buildCountyProjection(state, county, horizonYear) {
  const countyFips = `${state.padStart(2, '0')}${county.padStart(3, '0')}`;
  const { fetchCountyAcsHistory } = await import('./offlineData');
  const history = await fetchCountyAcsHistory(countyFips, ACS_HISTORY_YEARS);
  
  if (history.length < 2) return null;

  // Omit studentPopulation from county projections (county totals aren't meaningful for sites)
  const fields = ['income', 'rent', 'homeValue'];
  const projected = {};
  for (const f of fields) {
    projected[f] = linearProjectField(history, horizonYear, f);
  }
  projected.studentPopulation = null; // Explicitly null to avoid displaying county totals

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
 * Build projected metrics by aggregating tract-level projections.
 * Works the same as current aggregation (aggregateFromHeatmap) but with projected values.
 * Optimized: uses batch query for Supabase.
 */
async function buildTractAggregateProjection(features, horizonYear, radiusMiles) {
  if (!features || features.length === 0) return null;

  const geoids = features
    .map(f => f.properties?.geoid)
    .filter(Boolean);
  
  if (geoids.length === 0) return null;

  console.log(`[Projection] Computing for ${geoids.length} tracts...`);

  const { isSupabaseEnabled, fetchTractHistoryBatch } = await import('./offlineData');
  if (!isSupabaseEnabled()) {
    console.warn('[Projection] Supabase not configured — skipping tract aggregate projection.');
    return null;
  }

  console.log('[Projection] Supabase batch query...');
  const tractHistories = await fetchTractHistoryBatch(geoids, ACS_HISTORY_YEARS);
  console.log(`[Projection] Fetched ${tractHistories.size} tracts`);

  const projectedMetrics = [];

  for (const geoid of geoids) {
    const yearMap = tractHistories.get(geoid);
    if (!yearMap) continue;

    const history = [];
    for (const year of ACS_HISTORY_YEARS) {
      const yearNum = parseInt(year, 10);
      const data = yearMap.get(yearNum);
      if (data) {
        history.push({
          year: yearNum,
          income: data.income,
          rent: data.rent,
          homeValue: data.homeValue,
          studentPopulation: data.studentPopulation,
        });
      }
    }
    history.sort((a, b) => a.year - b.year);
    
    if (history.length < 2) continue;
    
    const proj = projectFuture(history, horizonYear - Math.max(...history.map(h => h.year)));
    if (proj.length === 0) continue;
    
    const projected = proj[proj.length - 1];
    if (projected) {
      projectedMetrics.push(projected);
    }
  }
  
  console.log(`[Projection] Generated ${projectedMetrics.length} tract projections`);
  
  if (projectedMetrics.length === 0) return null;
  
  // Aggregate projections the same way we aggregate current values (mean)
  const incomes = projectedMetrics.filter(p => p.income != null).map(p => p.income);
  const rents = projectedMetrics.filter(p => p.rent != null).map(p => p.rent);
  const homes = projectedMetrics.filter(p => p.homeValue != null).map(p => p.homeValue);
  const students = projectedMetrics.filter((p) => p.studentPopulation != null).map((p) => p.studentPopulation);
  const kStudents = students.length;
  const studentTotal = kStudents ? students.reduce((a, b) => a + b, 0) : null;
  const regionAreaSqMi = circleAreaSqMi(radiusMiles);

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const metrics = {
    income: mean(incomes),
    rent: mean(rents),
    homeValue: mean(homes),
    studentPopulation: studentTotal,
    studentTractCount: kStudents > 0 ? kStudents : null,
    studentRegionAreaSqMi: regionAreaSqMi > 0 ? regionAreaSqMi : null,
  };
  
  const historyYears = [...ACS_HISTORY_YEARS]
    .map((y) => parseInt(y, 10))
    .sort((a, b) => a - b);

  return {
    horizonYear,
    metrics,
    factorScores: metricsToScores(metrics),
    rawValues: metricsToRawValues(metrics),
    source: 'tract_aggregate',
    tractCount: projectedMetrics.length,
    historyYears,
  };
}

/**
 * County-level ACS history + projection for PDF / exports (geocoded point).
 */
export async function fetchCountyTrendForReport(lng, lat) {
  const geo = await geocodeCensusCounty(lng, lat);
  if (!geo) return null;

  const countyFips = `${geo.state}${geo.county}`;
  const { fetchCountyAcsHistory } = await import('./offlineData');
  const history = await fetchCountyAcsHistory(countyFips, ACS_HISTORY_YEARS);
  
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

export async function fetchAreaMetrics(lat, lng, radiusMiles, year = ACS_DATASET_YEAR, polygonLatLng = null) {
  let dataSource = 'tract';
  let tractCount = 0;

  let fc = { type: 'FeatureCollection', features: [] };
  try {
    fc = await fetchTractHeatmapGeoJson(lat, lng, radiusMiles, polygonLatLng);
  } catch {
    /* fall through to county */
  }

  tractCount = fc?.features?.length ?? 0;
  let agg = aggregateFromHeatmap(fc, radiusMiles);
  let metrics = agg.metrics;

  if (!hasAnyMetric(metrics)) {
    const geo = await geocodeCensusCounty(lng, lat);
    if (geo) {
      const countyMetrics = await fetchCountyMetricsRow(geo.state, geo.county, year);
      if (countyMetrics && hasAnyMetric(countyMetrics)) {
        metrics = {
          ...countyMetrics,
          studentPopulation: null,
          studentTractCount: null,
          studentRegionAreaSqMi: null,
        };
        agg = { metrics, factorScoresOverride: null };
        dataSource = 'county';
        tractCount = 0;
      }
    }
  }

  if (!hasAnyMetric(metrics)) {
    return neutralAreaMetrics(year);
  }

  const scores = agg.factorScoresOverride
    ? {
        'Median Income': coalesceFactorScore(agg.factorScoresOverride['Median Income']),
        'Median Rent': coalesceFactorScore(agg.factorScoresOverride['Median Rent']),
        'Median Home Value': coalesceFactorScore(agg.factorScoresOverride['Median Home Value']),
        School: coalesceFactorScore(agg.factorScoresOverride.School),
      }
    : metricsToScores(metrics);
  const rawValues = metricsToRawValues(metrics);

  // Build projection by aggregating tract-level projections (same as current aggregation)
  let projection = null;
  if (fc?.features?.length > 0) {
    const horizonYear = parseInt(year, 10) + PROJECTION_YEARS_AHEAD;
    projection = await buildTractAggregateProjection(fc.features, horizonYear, radiusMiles);
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
    /** Tracts intersecting the search radius (for map + in-radius location suggestions). */
    tractGeoJson: fc,
  };
}

/** Tract ACS history from Supabase only. */
export async function fetchTractHistory(geoid, years = ACS_YEARS) {
  const { fetchTractHistoryDirect } = await import('./offlineData');
  const supabaseData = await fetchTractHistoryDirect(geoid, years);

  if (!supabaseData || supabaseData.size === 0) return [];

  const history = [];
  for (const year of years) {
    const yearNum = parseInt(year, 10);
    const data = supabaseData.get(yearNum);

    if (data) {
      let studentPop = data.studentPopulation;
      if (studentPop != null && studentPop > 10000) {
        console.warn(
          `Tract ${geoid} year ${yearNum}: rejecting suspiciously high student population (${studentPop})`,
        );
        studentPop = null;
      }

      history.push({
        year: yearNum,
        income: data.income,
        rent: data.rent,
        homeValue: data.homeValue,
        studentPopulation: studentPop,
      });
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

    // Cap unrealistic growth for student population (tract-level: typically 100-5000)
    if (field === 'studentPopulation') {
      const lastY = points[points.length - 1].y;
      const avgY = sumY / n;
      return (yr) => {
        const raw = slope * yr + intercept;
        // Cap projection at 3x the average or last value + 50% per year, whichever is larger
        const maxReasonable = Math.max(avgY * 3, lastY * Math.pow(1.5, yr - points[points.length - 1].x));
        const capped = Math.min(raw, maxReasonable);
        // Return null if projection is negative (invalid)
        return capped < 0 ? null : Math.round(capped);
      };
    }

    return (yr) => {
      const v = slope * yr + intercept;
      // Return null if projection is negative (invalid)
      return v < 0 ? null : Math.round(v);
    };
  };

  const incomeProj = project('income');
  const rentProj = project('rent');
  const homeProj = project('homeValue');
  const spProj = project('studentPopulation');

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
      studentPopulation: spProj ? spProj(y) : null,
    });
  }

  return projections;
}

export { nationalTractZStats };
