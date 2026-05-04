/** Maps FactorPanel keys → tractScores JSON fields (precomputed per tract). */
export const FACTOR_TO_SCORE_FIELD = {
  "Median Income": "income",
  "Median Rent": "rent",
  "Median Home Value": "homeValue",
  School: "studentPopulation",
};

/**
 * Same weighting as App `computeWeightedScore`, using per-tract factor scores from GeoJSON.
 */
export function computeOverallFromTractScores(factors, scores) {
  if (!scores) return null;
  const enabledEntries = Object.entries(factors).filter(([, f]) => f.enabled);
  if (enabledEntries.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, factor] of enabledEntries) {
    const field = FACTOR_TO_SCORE_FIELD[key];
    if (!field) continue;
    const weight = factor.value;
    const score = Number(scores[field] ?? 0);
    weightedSum += score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

/** Choropleth / heatmap metric: weighted blend, or a single factor. */
export const CHOROPLETH_METRIC_WEIGHTED = "weighted";

/**
 * Score 0–100 used to color a tract for the chosen metric.
 * @param {string} metric - CHOROPLETH_METRIC_WEIGHTED or a FactorPanel key
 */
export function scoreForChoroplethMetric(metric, factors, scores) {
  if (!scores) return null;
  if (metric == null || metric === CHOROPLETH_METRIC_WEIGHTED) {
    return computeOverallFromTractScores(factors, scores);
  }
  const field = FACTOR_TO_SCORE_FIELD[metric];
  if (!field) return null;
  const v = scores[field];
  if (v == null || Number.isNaN(Number(v))) return null;
  return Math.round(Number(v));
}
