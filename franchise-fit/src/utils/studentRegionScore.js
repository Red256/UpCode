/**
 * Regional student-density score: R = total students in search circle / (π r²) sq mi; national benchmark is
 * median and robust scale (MAD × 1.4826) of per-tract students/sq mi. z = (R − median) / sigma.
 * UI factor label: "Student Density".
 *
 * Per-tract choropleth uses {@link scoreSchoolDensityHeadcount} with the same land area as the UI
 * (gazetteer + polygon fallback), so map colors match “students/sq mi” in popups.
 */
import nationalTractZStats from '../data/nationalTractZStats.json';

function zToScore(z) {
  if (z == null || Number.isNaN(z)) return 50;
  const s = 50 + 25 * z;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/**
 * National 0–100 score from enrollment density (students / land sq mi), vs national studentPerSqMi.
 */
export function scoreSchoolDensityHeadcount(enrollmentHeadcount, landSqMi) {
  if (
    enrollmentHeadcount == null ||
    Number.isNaN(Number(enrollmentHeadcount)) ||
    landSqMi == null ||
    Number.isNaN(Number(landSqMi)) ||
    landSqMi <= 0
  ) {
    return null;
  }
  const stats = nationalTractZStats.studentPerSqMi;
  const median = stats?.median ?? stats?.mu;
  if (!stats || median == null || stats.sigma == null || stats.sigma <= 0) return null;
  const ratio = Number(enrollmentHeadcount) / landSqMi;
  const z = (ratio - median) / stats.sigma;
  return zToScore(z);
}

/**
 * Fallback when land area is unknown: score enrollment headcount vs national enrollment distribution.
 * Matches scripts/precomputeAllTractScores.mjs branch when area is missing.
 */
export function scoreSchoolEnrollmentFallback(enrollmentHeadcount) {
  const hc = enrollmentHeadcount;
  if (hc == null || Number.isNaN(Number(hc))) return null;
  const stats = nationalTractZStats.studentPopulation;
  const median = stats?.median;
  if (!stats || median == null || stats.sigma == null || stats.sigma <= 0) return null;
  return zToScore((Number(hc) - median) / stats.sigma);
}

/**
 * @param {number|null|undefined} totalStudents
 * @param {number|null|undefined} regionAreaSqMi - search circle area πr² (sq mi)
 */
export function scoreStudentRegion(totalStudents, regionAreaSqMi) {
  if (
    totalStudents == null ||
    Number.isNaN(totalStudents) ||
    regionAreaSqMi == null ||
    regionAreaSqMi <= 0
  ) {
    return 50;
  }
  const stats = nationalTractZStats.studentPerSqMi;
  const median = stats?.median ?? stats?.mu;
  if (!stats || median == null || stats.sigma == null || stats.sigma <= 0) return 50;
  const ratio = totalStudents / regionAreaSqMi;
  const z = (ratio - median) / stats.sigma;
  return zToScore(z);
}
