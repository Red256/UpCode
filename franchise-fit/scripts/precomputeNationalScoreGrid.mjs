#!/usr/bin/env node
/**
 * Precompute nationwide score grid for heatmap visualization.
 * Uses tract centroids from local tractBoundaries/*.json + tractScores/*.json
 * (the Census gazetteer file is not used — the bundled copy was often a 404 HTML page).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import centroid from '@turf/centroid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const US_BOUNDS = {
  minLat: 24.5,
  maxLat: 49.0,
  minLng: -125.0,
  maxLng: -66.0,
};

// High-res grid (continental US)
const GRID_POINTS_LAT = 200;
const GRID_POINTS_LNG = 250;

/** ~0.1° cells for spatial hash (~7 mi); search uses neighboring cells */
const BUCKET_SCALE = 10;

function bucketKey(lat, lng) {
  return `${Math.floor(lat * BUCKET_SCALE)}_${Math.floor(lng * BUCKET_SCALE)}`;
}

function loadTractScoresForState(stateFips) {
  const tractFile = path.join(ROOT, 'src', 'data', 'tractScores', `${stateFips}.json`);
  try {
    return JSON.parse(fs.readFileSync(tractFile, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Build { geoid -> { lat, lng } } from tract boundaries, only for tracts that have scores.
 */
function buildCentroidIndex(tractScores) {
  console.log('Building tract centroid index from tractBoundaries/*.json...');
  const boundariesDir = path.join(ROOT, 'src', 'data', 'tractBoundaries');
  const files = fs.readdirSync(boundariesDir).filter((f) => /^\d{2}\.json$/.test(f));

  const locations = {};
  let featuresTotal = 0;
  let matched = 0;

  for (const file of files) {
    const fp = path.join(boundariesDir, file);
    let fc;
    try {
      fc = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) {
      console.warn(`Skip ${file}: ${e.message}`);
      continue;
    }
    const feats = fc.features || [];
    for (const f of feats) {
      featuresTotal++;
      const geoid = f.properties?.geoid ?? f.properties?.GEOID;
      if (!geoid || !tractScores[geoid]) continue;

      try {
        const c = centroid(f);
        const [lng, lat] = c.geometry.coordinates;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        locations[geoid] = { lat, lng };
        matched++;
      } catch {
        // skip bad geometry
      }
    }
  }

  console.log(
    `Boundary features scanned: ${featuresTotal}, centroids with scores: ${matched} (of ${Object.keys(tractScores).length} score keys)`
  );
  return locations;
}

function buildSpatialBuckets(tractLocations, tractScores) {
  /** @type {Record<string, Array<{ geoid: string, lat: number, lng: number }>>} */
  const buckets = {};

  for (const [geoid, loc] of Object.entries(tractLocations)) {
    if (!tractScores[geoid]) continue;
    const key = bucketKey(loc.lat, loc.lng);
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push({ geoid, lat: loc.lat, lng: loc.lng });
  }

  return buckets;
}

function getScoreComponents(tractScores, geoid) {
  const entry = tractScores[geoid];
  const s = entry?.scores;
  if (!s) return null;
  return {
    income: s.income ?? null,
    rent: s.rent ?? null,
    home_value: s.homeValue ?? null,
    school: s.studentPopulation ?? null,
  };
}

function computePointScore(lat, lng, tractScores, buckets, radiusMi = 10) {
  const latDegPerMi = 1 / 69.0;
  const lngDegPerMi = 1 / (69.0 * Math.cos((lat * Math.PI) / 180));

  const bi = Math.floor(lat * BUCKET_SCALE);
  const bj = Math.floor(lng * BUCKET_SCALE);

  const nearbyTracts = [];
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      const list = buckets[`${bi + di}_${bj + dj}`];
      if (!list) continue;
      for (const { geoid, lat: tLat, lng: tLng } of list) {
        const dist = Math.sqrt(
          Math.pow((lat - tLat) / latDegPerMi, 2) + Math.pow((lng - tLng) / lngDegPerMi, 2)
        );
        if (dist <= radiusMi) {
          nearbyTracts.push({ geoid, dist });
        }
      }
    }
  }

  if (nearbyTracts.length === 0) return null;

  let totalWeight = 0;
  const weighted = { income: 0, rent: 0, home_value: 0, school: 0 };
  const present = { income: false, rent: false, home_value: false, school: false };

  for (const { geoid, dist } of nearbyTracts) {
    const comp = getScoreComponents(tractScores, geoid);
    if (!comp) continue;

    const weight = 1 / (dist + 0.1);
    totalWeight += weight;

    for (const k of ['income', 'rent', 'home_value', 'school']) {
      const v = comp[k];
      if (v != null && v > 0) {
        weighted[k] += v * weight;
        present[k] = true;
      }
    }
  }

  if (totalWeight === 0) return null;

  const normalized = {
    income: present.income ? Math.round(weighted.income / totalWeight) : 0,
    rent: present.rent ? Math.round(weighted.rent / totalWeight) : 0,
    home_value: present.home_value ? Math.round(weighted.home_value / totalWeight) : 0,
    school: present.school ? Math.round(weighted.school / totalWeight) : 0,
  };

  const scores = [normalized.income, normalized.rent, normalized.home_value, normalized.school].filter(
    (s) => s > 0
  );
  const overall = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  if (overall <= 0) return null;
  return { ...normalized, overall };
}

async function loadAllTractScores() {
  const scoresDir = path.join(ROOT, 'src', 'data', 'tractScores');
  const files = fs.readdirSync(scoresDir).filter((f) => /^\d{2}\.json$/.test(f));
  const allScores = {};

  console.log('Loading tract scores...');
  for (const file of files) {
    const st = file.replace('.json', '');
    const data = loadTractScoresForState(st);
    if (data) Object.assign(allScores, data);
  }
  console.log(`Loaded ${Object.keys(allScores).length} tract score records`);
  return allScores;
}

async function main() {
  console.log('Starting nationwide score grid precomputation...');
  console.log(`Grid size: ${GRID_POINTS_LAT} x ${GRID_POINTS_LNG} = ${GRID_POINTS_LAT * GRID_POINTS_LNG} points`);

  const tractScores = await loadAllTractScores();
  if (Object.keys(tractScores).length === 0) {
    console.error('No tract scores found. Run: npm run precompute:tracts');
    process.exit(1);
  }

  const tractLocations = buildCentroidIndex(tractScores);
  if (Object.keys(tractLocations).length === 0) {
    console.error(
      'No tract centroids matched scores. Ensure src/data/tractBoundaries/*.json exists and GEOIDs match tractScores.'
    );
    process.exit(1);
  }

  const buckets = buildSpatialBuckets(tractLocations, tractScores);
  console.log(`Spatial buckets: ${Object.keys(buckets).length}`);

  const grid = [];
  const latStep = (US_BOUNDS.maxLat - US_BOUNDS.minLat) / (GRID_POINTS_LAT - 1);
  const lngStep = (US_BOUNDS.maxLng - US_BOUNDS.minLng) / (GRID_POINTS_LNG - 1);

  let processedPoints = 0;
  const totalPoints = GRID_POINTS_LAT * GRID_POINTS_LNG;
  const startTime = Date.now();

  console.log('\nComputing grid scores...');
  for (let i = 0; i < GRID_POINTS_LAT; i++) {
    for (let j = 0; j < GRID_POINTS_LNG; j++) {
      const lat = US_BOUNDS.minLat + i * latStep;
      const lng = US_BOUNDS.minLng + j * lngStep;

      const scores = computePointScore(lat, lng, tractScores, buckets, 12);

      if (scores) {
        grid.push({
          lat: parseFloat(lat.toFixed(4)),
          lng: parseFloat(lng.toFixed(4)),
          ...scores,
        });
      }

      processedPoints++;
      if (processedPoints % 1000 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const progress = ((processedPoints / totalPoints) * 100).toFixed(1);
        const ptsPerSec = elapsed > 0 ? (processedPoints / elapsed).toFixed(0) : '0';
        const etaMin =
          processedPoints > 0 && elapsed > 0
            ? (((totalPoints - processedPoints) / processedPoints) * elapsed / 60).toFixed(1)
            : '?';
        console.log(
          `Progress: ${progress}% (${processedPoints}/${totalPoints}) - ${elapsed.toFixed(1)}s - ${ptsPerSec} pts/s - ETA: ${etaMin}m - ${grid.length} valid`
        );
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
  console.log(`Valid points: ${grid.length} / ${totalPoints} (${((grid.length / totalPoints) * 100).toFixed(1)}%)`);

  const outputDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFile = path.join(outputDir, 'nationalScoreGrid.json');
  fs.writeFileSync(outputFile, JSON.stringify(grid));
  console.log(`\nSaved to: ${outputFile}`);
  console.log(`File size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
