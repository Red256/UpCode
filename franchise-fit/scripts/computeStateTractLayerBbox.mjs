/**
 * One-time / maintenance: bbox of each tractBoundaries/{st}.json file.
 * Used by tractHeatmap to load only states overlapping the map query (fast path).
 *
 * Run: node scripts/computeStateTractLayerBbox.mjs
 */
import bbox from '@turf/bbox';
import { writeFileSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '../src/data/tractBoundaries');
const outPath = join(__dirname, '../src/data/stateTractLayerBbox.json');

const out = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const st = f.replace('.json', '');
  const fc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  out[st] = bbox(fc);
}

writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log('Wrote', outPath, Object.keys(out).length, 'states');
