/**
 * Pull ACS 5-year tract variables for all tracts (one request per state when possible),
 * compute national median and robust scale (MAD × 1.4826) for z-scoring.
 *
 * Run: node scripts/computeNationalTractZStats.mjs
 * Output: src/data/nationalTractZStats.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { medianMADSigma } from './robustStats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../src/data/nationalTractZStats.json');

let preserveStudentPerSqMi = null;
try {
  const existing = JSON.parse(readFileSync(OUT, 'utf8'));
  const s = existing.studentPerSqMi;
  if (s && (s.median != null || s.mu != null)) preserveStudentPerSqMi = existing.studentPerSqMi;
} catch {
  /* no prior file */
}

const YEAR = '2024';
const VARS =
  'B19013_001E,B25064_001E,B25077_001E,B01003_001E,B14001_002E';
const CENSUS_MISSING = -666666666;

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

function ingestRows(data, incomes, rents, homes, enrollments) {
  if (!Array.isArray(data) || data.length < 2) return;
  const h = data[0];
  const ix = (n) => h.indexOf(n);
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const inc = row[ix('B19013_001E')];
    const rent = row[ix('B25064_001E')];
    const home = row[ix('B25077_001E')];
    const enr = row[ix('B14001_002E')];
    if (validPos(inc)) incomes.push(Number(inc));
    if (validPos(rent)) rents.push(Number(rent));
    if (validPos(home)) homes.push(Number(home));
    if (validNonNeg(enr)) enrollments.push(Number(enr));
  }
}

async function tractsByCounty(st, co, incomes, rents, homes, enrollments) {
  const data = await fetchJson(
    `https://api.census.gov/data/${YEAR}/acs/acs5?get=${VARS}&for=tract:*&in=state:${st}&in=county:${co}`
  );
  ingestRows(data, incomes, rents, homes, enrollments);
}

const incomes = [];
const rents = [];
const homes = [];
/** B14001_002E: people 3+ enrolled in school (count per tract) */
const enrollments = [];

const STATE_FIPS = [
  '01', '02', '04', '05', '06', '08', '09', '10', '11', '12', '13', '15', '16', '17', '18', '19',
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37', '38', '39', '40', '41', '42', '44', '45', '46', '47', '48', '49', '50', '51', '53',
  '54', '55', '56',
];

let stateWideOk = 0;
let countyFallback = 0;

for (const st of STATE_FIPS) {
  const stateUrl = `https://api.census.gov/data/${YEAR}/acs/acs5?get=${VARS}&for=tract:*&in=state:${st}`;
  try {
    const data = await fetchJson(stateUrl);
    ingestRows(data, incomes, rents, homes, enrollments);
    stateWideOk++;
    console.warn(`state ${st} tracts: ${(data?.length ?? 0) - 1}`);
  } catch {
    const countyRows = await fetchJson(
      `https://api.census.gov/data/${YEAR}/acs/acs5?get=NAME&for=county:*&in=state:${st}`
    );
    if (!Array.isArray(countyRows) || countyRows.length < 2) continue;
    const ch = countyRows[0];
    const countyIdx = ch.indexOf('county');
    for (let j = 1; j < countyRows.length; j++) {
      const co = countyRows[j][countyIdx];
      try {
        await tractsByCounty(st, co, incomes, rents, homes, enrollments);
        countyFallback++;
      } catch {
        /* skip county */
      }
    }
    console.warn(`state ${st} county fallback (${countyRows.length - 1} counties)`);
  }
}

const out = {
  acsYear: YEAR,
  description:
    'Per metric: national median and robust scale sigma = MAD × 1.4826 over census tracts with valid values. Z-scores use (value − median) / sigma. studentPerSqMi: students per land sq mi; regional School uses R = total students / sum tract areas, z = (R − median) / sigma.',
  income: medianMADSigma(incomes),
  rent: medianMADSigma(rents),
  homeValue: medianMADSigma(homes),
  studentPopulation: medianMADSigma(enrollments),
  _meta: {
    stateWideRequestsOk: stateWideOk,
    countyFallbackChunks: countyFallback,
    generatedAt: new Date().toISOString(),
  },
};

if (preserveStudentPerSqMi) {
  out.studentPerSqMi = preserveStudentPerSqMi;
}

for (const k of ['income', 'rent', 'homeValue', 'studentPopulation']) {
  const o = out[k];
  if (o.median != null) o.median = Math.round(o.median * 1000) / 1000;
  if (o.sigma != null) o.sigma = Math.round(o.sigma * 1000) / 1000;
}

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log('Wrote', OUT, {
  tractsIncome: incomes.length,
  tractsEnrollment: enrollments.length,
  meta: out._meta,
});
