/**
 * Merge tract precompute JSON + optional Census tract gazetteer (INTPTLAT/INTPTLONG) → tract_metrics.csv
 *
 * Download gazetteer (once): https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gazetteer_Census_Tracts.txt
 *
 *   node scripts/exportTractMetricsCsv.mjs path/to/2020_Gazetteer_Census_Tracts.txt
 *   node scripts/exportTractMetricsCsv.mjs   # without gazetteer: rows get lat/lng = 0 (not recommended)
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TRACT_DIR = join(ROOT, 'src/data/tractScores');
const ACS_YEAR = '2024';

function parseGazetteer(path) {
  const map = new Map();
  if (!path) return map;
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return map;
  const delim = lines[0].includes('\t') ? '\t' : '|';
  const header = lines[0].split(delim).map((h) => h.trim().toUpperCase());
  const iGeo = header.indexOf('GEOID');
  const iLat = header.indexOf('INTPTLAT');
  const iLng = header.indexOf('INTPTLONG');
  if (iGeo < 0 || iLat < 0 || iLng < 0) {
    console.warn('Gazetteer missing GEOID/INTPTLAT/INTPTLONG columns');
    return map;
  }
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    const geoid = String(cols[iGeo] ?? '').replace(/\D/g, '').slice(0, 11);
    if (geoid.length < 11) continue;
    const lat = parseFloat(cols[iLat]);
    const lng = parseFloat(cols[iLng]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    map.set(geoid, { lat, lng });
  }
  console.warn(`Gazetteer loaded: ${map.size} tract centroids`);
  return map;
}

function csvEscape(s) {
  if (s == null) return '';
  const t = String(s);
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

const gazPath = process.argv[2];
const gaz = parseGazetteer(gazPath);

const files = readdirSync(TRACT_DIR).filter((f) => f.endsWith('.json'));
const header = [
  'geoid',
  'tract_name',
  'state_fips',
  'intpt_lat',
  'intpt_lng',
  'income',
  'rent',
  'home_value',
  'student_population',
  'population',
  'score_income',
  'score_rent',
  'score_home_value',
  'score_student_population',
  'acs_year',
];

const outLines = [header.join(',')];
let missingCoord = 0;

for (const file of files) {
  const raw = readFileSync(join(TRACT_DIR, file), 'utf8');
  const data = JSON.parse(raw);
  for (const geoid of Object.keys(data)) {
    const row = data[geoid];
    const sc = row.scores || {};
    const r = row.raw || {};
    const st = geoid.slice(0, 2);
    const c = gaz.get(geoid);
    const lat = c?.lat ?? 0;
    const lng = c?.lng ?? 0;
    if (!c) missingCoord++;

    outLines.push(
      [
        csvEscape(geoid),
        csvEscape(r.name || ''),
        csvEscape(st),
        lat,
        lng,
        r.income ?? '',
        r.rent ?? '',
        r.homeValue ?? '',
        r.studentPopulation ?? '',
        r.population ?? '',
        sc.income ?? '',
        sc.rent ?? '',
        sc.homeValue ?? '',
        sc.studentPopulation ?? '',
        ACS_YEAR,
      ].join(',')
    );
  }
}

const outDir = join(ROOT, 'supabase/csv');
writeFileSync(join(outDir, 'tract_metrics.csv'), `${outLines.join('\n')}\n`, 'utf8');
console.log(`Wrote tract_metrics.csv (${outLines.length - 1} tracts). Missing gazetteer coords: ${missingCoord}`);
