/**
 * ACS 5-year estimates: one release per year (e.g. 2024 = 2020–2024 pooled).
 * We use the latest year the Census API serves; older years stay for trend history.
 * @see https://www.census.gov/programs-surveys/acs/news/data-releases.html
 */
export const ACS_DATASET_YEAR = '2024';

/** Years requested for county-level linear trend (newest first). */
export const ACS_HISTORY_YEARS = ['2024', '2023', '2022', '2021', '2020'];
