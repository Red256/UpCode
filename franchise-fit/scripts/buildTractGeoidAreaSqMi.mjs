/**
 * Build geoid -> land area (square miles) for census tracts.
 *
 * Primary source: Census 2020 Gazetteer ALAND_SQMI (official land area; matches ACS tabulations).
 * Fallback: @turf/area on local tract boundary GeoJSON (only for GEOIDs missing from the gazetteer,
 * e.g. rare post-2020 tract splits — simplified polygons may underestimate area).
 *
 * Run: node scripts/buildTractGeoidAreaSqMi.mjs
 * Output: src/data/tractGeoidAreaSqMi.json
 *
 * Requires: data/gazetteer/2020_Gaz_tracts_national.txt (tab; columns GEOID, ALAND_SQMI)
 */
import area from '@turf/area';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BDIR = join(__dirname, '../src/data/tractBoundaries');
const OUT = join(__dirname, '../src/data/tractGeoidAreaSqMi.json');
const GAZETTEER = join(__dirname, '../data/gazetteer/2020_Gaz_tracts_national.txt');

/** sq meters -> sq miles */
const M2_TO_SQMI = 1 / 2589988.110336;

function parseGazetteerLandSqMi(path) {
  const out = {};
  if (!existsSync(path)) {
    console.warn('Gazetteer not found:', path, '— using boundary Turf areas only (less accurate).');
    return out;
  }
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return out;
  const delim = lines[0].includes('\t') ? '\t' : '|';
  const header = lines[0].split(delim).map((h) => h.trim().toUpperCase());
  const iGeo = header.indexOf('GEOID');
  const iSqMi = header.indexOf('ALAND_SQMI');
  if (iGeo < 0 || iSqMi < 0) {
    console.warn('Gazetteer missing GEOID or ALAND_SQMI');
    return out;
  }
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    const geoid = String(cols[iGeo] ?? '')
      .replace(/\D/g, '')
      .slice(0, 11);
    const sqMi = parseFloat(String(cols[iSqMi] ?? '').replace(/,/g, ''));
    if (geoid.length === 11 && Number.isFinite(sqMi) && sqMi > 0) {
      out[geoid] = Math.round(sqMi * 1e6) / 1e6;
    }
  }
  console.warn('Gazetteer tract land areas:', Object.keys(out).length);
  return out;
}

function geoidFromFeature(f) {
  const p = f.properties || {};
  let g = p.GEOID || p.GEO_ID || p.geoid;
  if (g != null) {
    g = String(g).replace(/^1400000US/i, '').replace(/^.*US/i, '');
    g = String(g).replace(/\D/g, '');
  }
  if (!g || g.length < 11) {
    const st = p.STATE;
    const co = p.COUNTY;
    const tr = p.TRACT;
    if (st != null && co != null && tr != null) {
      g = `${String(st).padStart(2, '0')}${String(co).trim().padStart(3, '0')}${String(tr).trim().padStart(6, '0')}`;
    }
  }
  return g && g.length >= 11 ? g.slice(0, 11) : null;
}

const out = parseGazetteerLandSqMi(GAZETTEER);
let turfFallback = 0;

for (const file of readdirSync(BDIR).filter((x) => x.endsWith('.json'))) {
  const fc = JSON.parse(readFileSync(join(BDIR, file), 'utf8'));
  const feats = fc.features || [];
  for (const f of feats) {
    const gid = geoidFromFeature(f);
    if (!gid || !f.geometry) continue;
    if (out[gid] != null && out[gid] > 0) continue;
    try {
      const m2 = area(f);
      const sqMi = m2 * M2_TO_SQMI;
      if (sqMi > 1e-9) {
        out[gid] = Math.round(sqMi * 1e6) / 1e6;
        turfFallback++;
      }
    } catch {
      /* skip */
    }
  }
}

if (turfFallback) {
  console.warn('Turf fallback (not in gazetteer):', turfFallback, 'tracts');
}

writeFileSync(OUT, `${JSON.stringify(out)}\n`, 'utf8');
console.log('Wrote', OUT, 'keys', Object.keys(out).length);
