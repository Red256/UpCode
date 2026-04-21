/**
 * Merge studentPerSqMi (median, MAD×1.4826 scale) into nationalTractZStats.json from:
 * - tractGeoidAreaSqMi.json (from buildTractGeoidAreaSqMi.mjs)
 * - tractAcsHistory.csv (student_population for ACS year)
 *
 * Run: node scripts/mergeStudentPerSqMiNational.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { medianMADSigma } from './robustStats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NATIONAL_PATH = join(ROOT, 'src/data/nationalTractZStats.json');
const AREA_PATH = join(ROOT, 'src/data/tractGeoidAreaSqMi.json');
const CSV_PATH = join(ROOT, 'src/data/tractAcsHistory.csv');

const national = JSON.parse(readFileSync(NATIONAL_PATH, 'utf8'));
const YEAR = String(national.acsYear || '2024');

let areaMap;
try {
  areaMap = JSON.parse(readFileSync(AREA_PATH, 'utf8'));
} catch (e) {
  console.error('Missing', AREA_PATH, '— run: node scripts/buildTractGeoidAreaSqMi.mjs');
  process.exit(1);
}

const ratios = [];
const text = readFileSync(CSV_PATH, 'utf8');
const lines = text.split('\n');
const header = lines[0].split(',');
const ig = header.indexOf('geoid');
const iy = header.indexOf('year');
const is = header.indexOf('student_population');

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const parts = line.split(',');
  const geoid = parts[ig]?.replace(/\D/g, '').padStart(11, '0');
  const year = parts[iy];
  const sp = parts[is];
  if (!geoid || year !== YEAR) continue;
  const a = areaMap[geoid];
  if (a == null || a <= 0) continue;
  const students = Number(sp);
  if (Number.isNaN(students) || students < 0) continue;
  ratios.push(students / a);
}

const studentPerSqMi = { ...medianMADSigma(ratios), unit: 'students_per_sq_mi' };
if (studentPerSqMi.median != null) studentPerSqMi.median = Math.round(studentPerSqMi.median * 1000) / 1000;
if (studentPerSqMi.sigma != null) studentPerSqMi.sigma = Math.round(studentPerSqMi.sigma * 1000) / 1000;

national.studentPerSqMi = studentPerSqMi;

writeFileSync(NATIONAL_PATH, `${JSON.stringify(national, null, 2)}\n`, 'utf8');
console.log('Updated nationalTractZStats.json studentPerSqMi', studentPerSqMi, 'sample ratios', ratios.length);
