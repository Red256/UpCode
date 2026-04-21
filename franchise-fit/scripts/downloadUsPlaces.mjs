/**
 * Download US places (cities, towns) with coordinates for offline geocoding.
 * Uses GeoNames cities5000 database (cities with population > 5000).
 * 
 * Output: src/data/usPlaces.json
 * 
 * Run: node scripts/downloadUsPlaces.mjs
 */

import { writeFileSync, mkdirSync, existsSync, createWriteStream } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '../src/data/usPlaces.json');
const TEMP_DIR = join(__dirname, '../temp');
const TEMP_ZIP = join(TEMP_DIR, 'cities5000.zip');
const TEMP_TXT = join(TEMP_DIR, 'cities5000.txt');

// GeoNames cities with pop > 5000 (smaller, faster download)
const GEONAMES_URL = 'https://download.geonames.org/export/dump/cities5000.zip';

const STATE_NAME = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
  'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'DC': 'District of Columbia',
  'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois',
  'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana',
  'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
  'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
  'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
  'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon',
  'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota',
  'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia',
  'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
};

const STATE_FIPS_TO_ABBR = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV',
  '55': 'WI', '56': 'WY',
};

// State ABBR to FIPS for admin1 code lookup
const STATE_ABBR_TO_FIPS = Object.fromEntries(
  Object.entries(STATE_FIPS_TO_ABBR).map(([k, v]) => [v, k])
);

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  
  const fileStream = createWriteStream(dest);
  await pipeline(res.body, fileStream);
  console.log(`Saved to ${dest}`);
}

async function main() {
  mkdirSync(TEMP_DIR, { recursive: true });
  
  // Download ZIP file
  await downloadFile(GEONAMES_URL, TEMP_ZIP);
  
  // Extract using PowerShell (works on Windows)
  console.log('Extracting...');
  try {
    execSync(`powershell -Command "Expand-Archive -Path '${TEMP_ZIP}' -DestinationPath '${TEMP_DIR}' -Force"`, { stdio: 'inherit' });
  } catch (err) {
    console.error('Failed to extract. Trying tar...');
    execSync(`tar -xf "${TEMP_ZIP}" -C "${TEMP_DIR}"`, { stdio: 'inherit' });
  }
  
  // Read the extracted file
  const { readFileSync } = await import('fs');
  const text = readFileSync(TEMP_TXT, 'utf8');
  
  console.log('Parsing places...');
  const lines = text.split('\n');
  
  // GeoNames format: tab-separated
  // 0: geonameid, 1: name, 2: asciiname, 3: alternatenames, 4: latitude, 5: longitude,
  // 6: feature class, 7: feature code, 8: country code, 9: cc2, 10: admin1 code,
  // 11: admin2 code, 12: admin3 code, 13: admin4 code, 14: population, ...
  
  const places = [];
  const seen = new Set();
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    const fields = line.split('\t');
    if (fields.length < 15) continue;
    
    const name = fields[1]?.trim();
    const lat = parseFloat(fields[4]);
    const lng = parseFloat(fields[5]);
    const countryCode = fields[8];
    const admin1 = fields[10]?.trim();  // State abbreviation or code
    const population = parseInt(fields[14]) || 0;
    
    // Only US places
    if (countryCode !== 'US') continue;
    
    // admin1 is the state abbreviation in GeoNames US data
    const stAbbr = admin1?.toUpperCase();
    if (!stAbbr || !STATE_NAME[stAbbr]) continue;
    
    if (!name || isNaN(lat) || isNaN(lng)) continue;
    
    // Dedupe by name + state
    const key = `${name.toLowerCase()}_${stAbbr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    
    places.push({
      n: name,
      s: stAbbr,
      f: STATE_NAME[stAbbr],
      lat: Math.round(lat * 100000) / 100000,
      lng: Math.round(lng * 100000) / 100000,
      p: population,
    });
  }
  
  // Sort by population (descending) then name
  places.sort((a, b) => {
    if (b.p !== a.p) return b.p - a.p;
    return a.n.localeCompare(b.n);
  });
  
  // Remove population field to save space
  const output = places.map(({ n, s, f, lat, lng }) => ({ n, s, f, lat, lng }));
  
  console.log(`Parsed ${output.length} US places`);
  
  writeFileSync(OUT_FILE, JSON.stringify(output), 'utf8');
  console.log(`Wrote ${OUT_FILE}`);
  
  // Cleanup temp files
  try {
    const { rmSync } = await import('fs');
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
