/**
 * Download tract-level ACS history for all US tracts (2020-2024).
 * This is a large dataset (~84k tracts × 5 years = ~420k rows).
 * 
 * Fetches county-by-county to avoid Census API size limits.
 * 
 * Output: src/data/tractAcsHistory.csv
 * 
 * Run: node scripts/downloadTractAcsHistory.mjs
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '../src/data/tractAcsHistory.csv');

const YEARS = ['2020', '2021', '2022', '2023', '2024'];
const VARS = 'B19013_001E,B25064_001E,B25077_001E,B14001_002E';
const CENSUS_MISSING = -666666666;

const STATE_FIPS = [
  '01', '02', '04', '05', '06', '08', '09', '10', '11', '12', '13', '15', '16', '17', '18', '19',
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37', '38', '39', '40', '41', '42', '44', '45', '46', '47', '48', '49', '50', '51', '53',
  '54', '55', '56',
];

function buildGeoid(state, county, tract) {
  return `${state.padStart(2, '0')}${county.padStart(3, '0')}${tract.padStart(6, '0')}`;
}

function cleanValue(v) {
  if (v == null || v === '' || v === CENSUS_MISSING || v === '-666666666') return '';
  const n = Number(v);
  return isNaN(n) || n < 0 ? '' : String(n);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchCountiesInState(state) {
  const url = `https://api.census.gov/data/2020/acs/acs5?get=NAME&for=county:*&in=state:${state}`;
  try {
    const data = await fetchJson(url);
    if (!data || data.length < 2) return [];
    
    const headers = data[0];
    const countyIdx = headers.indexOf('county');
    const counties = [];
    
    for (let i = 1; i < data.length; i++) {
      const county = data[i][countyIdx];
      if (county) counties.push(county.padStart(3, '0'));
    }
    
    return counties;
  } catch {
    return [];
  }
}

async function fetchCountyYearTracts(state, county, year) {
  const url = `https://api.census.gov/data/${year}/acs/acs5?get=${VARS}&for=tract:*&in=state:${state}&in=county:${county}`;
  return fetchJson(url);
}

console.log('Downloading tract ACS history (county-by-county, 5 years)...');
console.log('This will take 15-20 minutes.\n');

const rows = [];
rows.push('geoid,year,income,rent,home_value,student_population');

let totalRows = 0;

for (const state of STATE_FIPS) {
  console.log(`State ${state}...`);
  
  const counties = await fetchCountiesInState(state);
  if (counties.length === 0) {
    console.log('  No counties found, skipping');
    continue;
  }
  
  console.log(`  Processing ${counties.length} counties...`);
  
  for (const county of counties) {
    process.stdout.write('.');
    
    for (const year of YEARS) {
      const data = await fetchCountyYearTracts(state, county, year);
      if (!data || data.length < 2) continue;
      
      const headers = data[0];
      const incIdx = headers.indexOf('B19013_001E');
      const rentIdx = headers.indexOf('B25064_001E');
      const homeIdx = headers.indexOf('B25077_001E');
      const studIdx = headers.indexOf('B14001_002E');
      const stIdx = headers.indexOf('state');
      const coIdx = headers.indexOf('county');
      const trIdx = headers.indexOf('tract');
      
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const geoid = buildGeoid(row[stIdx], row[coIdx], row[trIdx]);
        const income = cleanValue(row[incIdx]);
        const rent = cleanValue(row[rentIdx]);
        const homeValue = cleanValue(row[homeIdx]);
        const studentPop = cleanValue(row[studIdx]);
        
        if (income || rent || homeValue || studentPop) {
          rows.push(`${geoid},${year},${income},${rent},${homeValue},${studentPop}`);
          totalRows++;
        }
      }
      
      // Small delay between requests
      await new Promise(r => setTimeout(r, 50));
    }
  }
  
  console.log(`\n  ✓ ${totalRows} total rows so far`);
}

console.log(`\nWriting ${rows.length - 1} data rows...`);
writeFileSync(OUT_FILE, rows.join('\n'), 'utf8');
console.log(`Done. Output: ${OUT_FILE}`);
