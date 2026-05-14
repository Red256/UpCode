/**
 * Area-level weighted score from cached 0–100 factor scores.
 * Used to update overall instantly when slider weights change (no refetch).
 */

/**
 * @param {Record<string, { enabled: boolean; value: number }>} factors
 * @param {Record<string, number | null | undefined>} factorScores - 0–100 per factor key
 * @param {Record<string, unknown>} factorRawValues - display strings per factor key
 */
export function computeWeightedScore(factors, factorScores, factorRawValues) {
  const enabledEntries = Object.entries(factors).filter(([, f]) => f.enabled);

  if (enabledEntries.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;
  const breakdown = {};

  enabledEntries.forEach(([key, factor]) => {
    const weight = factor.value;
    const score = Number(factorScores[key] ?? 0);

    weightedSum += score * weight;
    totalWeight += weight;

    breakdown[key] = {
      factorScore: score,
      raw_value: factorRawValues[key],
      contribution: totalWeight === 0 ? 0 : Math.round((score * weight) / totalWeight),
    };
  });

  const overall = totalWeight === 0 ? 0 : weightedSum / totalWeight;

  return {
    overall: Math.round(overall),
    breakdown,
  };
}

/** Recover plain raw-value map from stored `raw_values` breakdown objects. */
export function metricRawValuesFromBreakdown(rawValuesBreakdown) {
  if (!rawValuesBreakdown || typeof rawValuesBreakdown !== "object") return {};
  const o = {};
  for (const [k, v] of Object.entries(rawValuesBreakdown)) {
    if (v && typeof v === "object" && "raw_value" in v) o[k] = v.raw_value;
    else o[k] = v;
  }
  return o;
}
