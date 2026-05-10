/**
 * ACS 5-year estimates: one release per year (e.g. 2024 = 2020–2024 pooled).
 * We use the latest year the Census API serves; older years stay for trend history.
 * @see https://www.census.gov/programs-surveys/acs/news/data-releases.html
 */
export const ACS_DATASET_YEAR = '2024';

/** Years requested for county-level linear trend (newest first). */
export const ACS_HISTORY_YEARS = ['2024', '2023', '2022', '2021', '2020'];

/** ACS table B25077 top-coded median value bucket ("$2,000,001 or more"). */
export const ACS_HOME_VALUE_TOP_CODE = 2000001;

/** Format tract-level median home value for UI/PDF (handles ACS top code). */
export function formatMedianHomeValueDisplay(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Math.round(Number(value));
  if (n === ACS_HOME_VALUE_TOP_CODE) return '>2000001';
  return `$${n.toLocaleString('en-US')}`;
}
