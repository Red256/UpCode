/**
 * Robust location / scale: median and MAD × 1.4826 (normal-consistent σ analog).
 */
const MAD_SCALE = 1.4826;

function medianOfSorted(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {number[]} arr
 * @returns {{ median: number|null, sigma: number|null, n: number }} sigma = MAD * 1.4826
 */
export function medianMADSigma(arr) {
  const vals = arr.filter((x) => x != null && !Number.isNaN(Number(x))).map(Number);
  const n = vals.length;
  if (n === 0) return { median: null, sigma: null, n: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const med = medianOfSorted(sorted);
  if (n === 1) return { median: med, sigma: 0, n: 1 };
  const devs = vals.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = medianOfSorted(devs);
  const sigma = mad * MAD_SCALE;
  return { median: med, sigma: sigma > 0 ? sigma : null, n };
}
