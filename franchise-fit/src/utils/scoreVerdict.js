/** Shared UI verdict for overall scores (ScoreCard, saved locations, etc.). */
export function getVerdict(score) {
  if (score >= 85) return { text: "Excellent", cls: "ok" };
  if (score >= 75) return { text: "Strong", cls: "ok" };
  if (score >= 65) return { text: "Moderate", cls: "warn" };
  return { text: "Risky", cls: "bad" };
}
