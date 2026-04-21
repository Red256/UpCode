/**
 * Download tract boundary GeoJSON from TIGERweb for all US states.
 * Output: src/data/tractBoundaries/{state}.json (simplified polygons + GEOID)
 * 
 * Fetches county-by-county to avoid TIGERweb's size limits.
 * 
 * Run: node scripts/downloadTractBoundaries.mjs
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../src/data/tractBoundaries');

const STATE_FIPS = [
  '01', '02', '04', '05', '06', '08', '09', '10', '11', '12', '13', '15', '16', '17', '18', '19',
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37', '38', '39', '40', '41', '42', '44', '45', '46', '47', '48', '49', '50', '51', '53',
  '54', '55', '56',
];

const TIGER_LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/7/query';
const COUNTY_LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query';

async function fetchCountiesInState(stateFips) {
  const params = new URLSearchParams({
    where: `STATE='${stateFips}'`,
    outFields: 'STATE,COUNTY,NAME',
    returnGeometry: 'false',
    f: 'json',
  });

  const url = `${COUNTY_LAYER}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  
  const data = await res.json();
  const features = data.features || [];
  
  return features.map(f => ({
    state: f.attributes.STATE,
    county: String(f.attributes.COUNTY).padStart(3, '0'),
    name: f.attributes.NAME,
  }));
}

async function fetchTractsInCounty(stateFips, countyFips) {
  const params = new URLSearchParams({
    where: `STATE='${stateFips}' AND COUNTY='${countyFips}'`,
    outFields: 'STATE,COUNTY,TRACT,NAME,GEOID',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });

  const url = `${TIGER_LAYER}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const gj = await res.json();
  return gj.features || [];
}

async function fetchStateTracts(stateFips) {
  const counties = await fetchCountiesInState(stateFips);
  if (counties.length === 0) {
    console.log(`    No counties found, trying direct state query...`);
    // Fallback for small states
    return fetchTractsDirectly(stateFips);
  }

  const all = [];
  console.log(`    Fetching ${counties.length} counties...`);
  
  for (const county of counties) {
    try {
      const tracts = await fetchTractsInCounty(stateFips, county.county);
      all.push(...tracts);
      process.stdout.write('.');
      
      // Small delay to be nice to the server
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      process.stdout.write('x');
    }
  }
  
  console.log('');
  return all;
}

async function fetchTractsDirectly(stateFips) {
  const params = new URLSearchParams({
    where: `STATE='${stateFips}'`,
    outFields: 'STATE,COUNTY,TRACT,NAME,GEOID',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });

  const url = `${TIGER_LAYER}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const gj = await res.json();
  return gj.features || [];
}

function simplifyCoords(coords, precision = 5) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    return [
      Math.round(coords[0] * 10 ** precision) / 10 ** precision,
      Math.round(coords[1] * 10 ** precision) / 10 ** precision,
    ];
  }
  return coords.map(c => simplifyCoords(c, precision));
}

function simplifyFeature(f) {
  const p = f.properties || {};
  const geoid = String(p.GEOID || '').replace(/^1400000US/i, '').slice(0, 11);
  
  return {
    type: 'Feature',
    properties: {
      geoid,
      name: p.NAME || '',
    },
    geometry: {
      type: f.geometry?.type || 'Polygon',
      coordinates: simplifyCoords(f.geometry?.coordinates, 5),
    },
  };
}

mkdirSync(OUT_DIR, { recursive: true });

console.log('Downloading tract boundaries from TIGERweb (county-by-county)...');
console.log('This will take 10-15 minutes for all 51 states.\n');

for (const st of STATE_FIPS) {
  console.log(`State ${st}...`);
  
  try {
    const features = await fetchStateTracts(st);
    const simplified = features.map(simplifyFeature);
    
    const fc = {
      type: 'FeatureCollection',
      features: simplified,
    };
    
    writeFileSync(join(OUT_DIR, `${st}.json`), JSON.stringify(fc), 'utf8');
    console.log(`  ✓ ${simplified.length} tracts saved`);
  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    writeFileSync(join(OUT_DIR, `${st}.json`), '{"type":"FeatureCollection","features":[]}', 'utf8');
  }
}

console.log(`\nDone. Output: ${OUT_DIR}`);
