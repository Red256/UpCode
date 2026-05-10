/**
 * Add { centroid: { lat, lng } } to each tract in src/data/tractScores/{state}.json
 * using polygon centroids from src/data/tractBoundaries/{state}.json.
 *
 * Run after:
 *   npm run precompute:tracts
 *   npm run download:boundaries   (or equivalent for states you need)
 *
 *   node scripts/enrichTractScoresCentroids.mjs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import centroid from '@turf/centroid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCORES_DIR = join(ROOT, 'src/data/tractScores');
const BOUNDARY_DIR = join(ROOT, 'src/data/tractBoundaries');

function normGeoidFromProps(p) {
  let geoid = p.GEOID || p.GEO_ID || p.geoid;
  if (geoid != null) {
    geoid = String(geoid).replace(/^1400000US/i, '').replace(/^.*US/i, '');
    geoid = String(geoid).replace(/\D/g, '');
  }
  if (geoid && geoid.length >= 11) return geoid.slice(0, 11);
  return null;
}

function centroidsFromBoundaryFile(st) {
  const path = join(BOUNDARY_DIR, `${st}.json`);
  if (!existsSync(path)) return new Map();
  const fc = JSON.parse(readFileSync(path, 'utf8'));
  const map = new Map();
  for (const f of fc.features || []) {
    const g = normGeoidFromProps(f.properties || {});
    if (!g || !f.geometry) continue;
    try {
      const c = centroid(f);
      const [lng, lat] = c.geometry.coordinates;
      map.set(g, { lat, lng });
    } catch {
      /* invalid geometry */
    }
  }
  return map;
}

let total = 0;
let enriched = 0;

if (!existsSync(SCORES_DIR)) {
  console.error('Missing', SCORES_DIR);
  process.exit(1);
}

for (const name of readdirSync(SCORES_DIR)) {
  if (!name.endsWith('.json')) continue;
  const st = name.replace('.json', '');
  const scoresPath = join(SCORES_DIR, name);
  const data = JSON.parse(readFileSync(scoresPath, 'utf8'));
  const cenMap = centroidsFromBoundaryFile(st);
  let n = 0;
  for (const [geoid, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object') continue;
    total += 1;
    const c = cenMap.get(geoid);
    if (!c) continue;
    entry.centroid = { lat: c.lat, lng: c.lng };
    enriched += 1;
    n += 1;
  }
  writeFileSync(scoresPath, `${JSON.stringify(data)}\n`, 'utf8');
  console.log(`state ${st}: centroids set for ${n} tracts (boundary map size ${cenMap.size})`);
}

console.log(`Done. Tract entries scanned: ${total}, centroids written: ${enriched}`);
