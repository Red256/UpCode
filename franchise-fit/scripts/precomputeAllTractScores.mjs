/**
 * Precompute 0–100 factor scores + raw ACS fields for every US census tract.
 * Run after nationalTractZStats.json exists (same ACS year).
 *
 *   node scripts/computeNationalTractZStats.mjs
 *   node scripts/precomputeAllTractScores.mjs
 *
 * Output: src/data/tractScores/{state}.json
 *
 * Optional: add stable centroids from tract polygons (faster map / suggestions):
 *   npm run download:boundaries
 *   npm run enrich:tract-centroids
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NATIONAL = JSON.parse(readFileSync(join(ROOT, 'src/data/nationalTractZStats.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'src/data/tractScores');

let AREA_MAP = {};
try {
  AREA_MAP = JSON.parse(readFileSync(join(ROOT, 'src/data/tractGeoidAreaSqMi.json'), 'utf8'));
} catch {
  console.warn('tractGeoidAreaSqMi.json missing — run node scripts/buildTractGeoidAreaSqMi.mjs (School uses count z-score fallback)');
}

const YEAR = NATIONAL.acsYear || '2024';
const VARS =
  'NAME,B19013_001E,B25064_001E,B25077_001E,B01003_001E,B14001_002E';
const CENSUS_MISSING = -666666666;

function zToScore(z) {
  if (z == null || Number.isNaN(z)) return null;
  const s = 50 + 25 * z;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** National median and robust scale (sigma = MAD × 1.4826); legacy `mu` treated as median. */
function nationalMedianSigma(metricKey) {
  const b = NATIONAL[metricKey];
  const med = b?.median ?? b?.mu;
  const sig = b?.sigma;
  if (!b || med == null || sig == null || sig <= 1e-12) return { median: null, sigma: 0 };
  return { median: med, sigma: sig };
}

function validPos(v) {
  const n = Number(v);
  return !Number.isNaN(n) && n > 0 && n !== CENSUS_MISSING;
}

function validNonNeg(v) {
  const n = Number(v);
  return !Number.isNaN(n) && n >= 0 && n !== CENSUS_MISSING;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
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

function rowToTractEntry(row, headers, geoid) {
  const idx = (name) => headers.indexOf(name);
  const income = row[idx('B19013_001E')];
  const rent = row[idx('B25064_001E')];
  const home = row[idx('B25077_001E')];
  const pop = row[idx('B01003_001E')];
  const enrolled = row[idx('B14001_002E')];
  const popN = Number(pop);
  const enrN = Number(enrolled);
  const studentPopulation = validNonNeg(enrolled) ? enrN : null;

  const raw = {
    income: validPos(income) ? Number(income) : null,
    rent: validPos(rent) ? Number(rent) : null,
    homeValue: validPos(home) ? Number(home) : null,
    studentPopulation,
    population: validPos(pop) ? popN : null,
    name: row[idx('NAME')] != null ? String(row[idx('NAME')]) : '',
  };

  const scores = {};
  for (const key of ['income', 'rent', 'homeValue']) {
    const v = raw[key];
    const { median, sigma } = nationalMedianSigma(key);
    if (v == null || Number.isNaN(v) || median == null) {
      scores[key] = null;
      continue;
    }
    const z = sigma > 1e-12 ? (v - median) / sigma : 0;
    scores[key] = zToScore(z);
  }

  const areaSqMi = AREA_MAP[geoid];
  const { median: medD, sigma: sigmaD } = nationalMedianSigma('studentPerSqMi');
  if (studentPopulation != null && areaSqMi > 0 && medD != null && sigmaD > 1e-12) {
    const ratio = studentPopulation / areaSqMi;
    const z = (ratio - medD) / sigmaD;
    scores.studentPopulation = zToScore(z);
  } else if (studentPopulation != null) {
    const { median, sigma } = nationalMedianSigma('studentPopulation');
    scores.studentPopulation =
      median != null && sigma > 1e-12 ? zToScore((studentPopulation - median) / sigma) : null;
  } else {
    scores.studentPopulation = null;
  }

  return { scores, raw };
}

function ingestStateData(data) {
  const out = {};
  if (!Array.isArray(data) || data.length < 2) return out;
  const headers = data[0];
  const stateIdx = headers.indexOf('state');
  const countyIdx = headers.indexOf('county');
  const tractIdx = headers.indexOf('tract');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const st = row[stateIdx];
    const co = row[countyIdx];
    const tr = row[tractIdx];
    if (st == null || co == null || tr == null) continue;
    const geoid = buildGeoid(st, co, tr);
    out[geoid] = rowToTractEntry(row, headers, geoid);
  }
  return out;
}

const STATE_FIPS = [
  '01', '02', '04', '05', '06', '08', '09', '10', '11', '12', '13', '15', '16', '17', '18', '19',
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37', '38', '39', '40', '41', '42', '44', '45', '46', '47', '48', '49', '50', '51', '53',
  '54', '55', '56',
];

mkdirSync(OUT_DIR, { recursive: true });

async function tractsByCounty(st, co) {
  return fetchJson(
    `https://api.census.gov/data/${YEAR}/acs/acs5?get=${VARS}&for=tract:*&in=state:${st}&in=county:${co}`
  );
}

for (const st of STATE_FIPS) {
  let merged = {};
  const stateUrl = `https://api.census.gov/data/${YEAR}/acs/acs5?get=${VARS}&for=tract:*&in=state:${st}`;
  try {
    const data = await fetchJson(stateUrl);
    merged = ingestStateData(data);
    console.warn(`state ${st} tracts: ${Object.keys(merged).length}`);
  } catch {
    const countyRows = await fetchJson(
      `https://api.census.gov/data/${YEAR}/acs/acs5?get=NAME&for=county:*&in=state:${st}`
    );
    if (!Array.isArray(countyRows) || countyRows.length < 2) {
      console.warn(`state ${st} skip`);
      writeFileSync(join(OUT_DIR, `${st}.json`), '{}\n', 'utf8');
      continue;
    }
    const ch = countyRows[0];
    const countyIdx = ch.indexOf('county');
    for (let j = 1; j < countyRows.length; j++) {
      const co = countyRows[j][countyIdx];
      try {
        const data = await tractsByCounty(st, co);
        const part = ingestStateData(data);
        Object.assign(merged, part);
      } catch {
        /* skip */
      }
    }
    console.warn(`state ${st} county fallback tracts: ${Object.keys(merged).length}`);
  }

  writeFileSync(join(OUT_DIR, `${st}.json`), `${JSON.stringify(merged)}\n`, 'utf8');
}

console.log('Done. Output:', OUT_DIR);
