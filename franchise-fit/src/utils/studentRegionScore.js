/**
 * Regional School score: R = total students in search circle / (π r²) sq mi; national benchmark is
 * median and robust scale (MAD × 1.4826) of per-tract students/sq mi. z = (R − median) / sigma.
 */
import nationalTractZStats from '../data/nationalTractZStats.json';

function zToScore(z) {
  if (z == null || Number.isNaN(z)) return 50;
  const s = 50 + 25 * z;
  return Math.max(0, Math.min(100, Math.round(s)));
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
