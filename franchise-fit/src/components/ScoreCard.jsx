import { getVerdict } from "../utils/scoreVerdict";

function getScoreColor(score) {
  if (score >= 85) return "#16a34a";
  if (score >= 75) return "#22c55e";
  if (score >= 65) return "#f59e0b";
  return "#ef4444";
}

function ScoreRing({ value, color }) {
  const circumference = 2 * Math.PI * 52;
  const offset = circumference - (value / 100) * circumference;
  return (
    <div className="score-ring">
      <svg viewBox="0 0 120 120" className="score-ring-svg">
        <circle cx="60" cy="60" r="52" className="score-ring-bg" />
        <circle
          cx="60"
          cy="60"
          r="52"
          className="score-ring-fill"
          style={{
            strokeDasharray: circumference,
            strokeDashoffset: offset,
            stroke: color,
          }}
        />
      </svg>
      <div className="score-ring-value" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

export default function ScoreCard({ factors, analysisResult }) {
  const enabled = Object.entries(factors).filter(([, f]) => f.enabled);

  if (enabled.length === 0 || !analysisResult) {
    return null;
  }

  const avg = analysisResult.overall;
  const verdict = getVerdict(avg);
  const color = getScoreColor(avg);
  const proj = analysisResult.projection;
  const projColor = proj ? getScoreColor(proj.overall) : null;
  const acsYear = analysisResult.acsDatasetYear ?? "";

  return (
    <div className="card score-card" style={{ animation: "fadeIn 0.4s ease-out" }}>
      <div className={`score-card-inner ${proj ? "score-card-inner-dual" : ""}`}>
        <div className="score-pillar">
          <div className="score-pillar-label">
            Current score
            {acsYear ? (
              <span className="score-pillar-sublabel"> (ACS {acsYear})</span>
            ) : null}
          </div>
          <div className="score-pillar-body">
            <ScoreRing value={avg} color={color} />
            <div className="score-info">
              <div className="score-label">Overall</div>
              <span className={`badge ${verdict.cls}`}>{verdict.text}</span>
              <div className="score-detail">
                Based on {enabled.length} active factor{enabled.length !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
        </div>

        {proj && (
          <div className="score-pillar score-pillar-projected">
            <div className="score-pillar-label">
              Projected overall
              <span className="score-pillar-sublabel"> ({proj.horizonYear})</span>
            </div>
            <div className="score-pillar-body">
              <ScoreRing value={proj.overall} color={projColor} />
              <div className="score-info">
                <div className="score-label">Trend estimate</div>
                <span
                  className={`badge ${proj.deltaOverall >= 0 ? "ok" : "bad"}`}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {proj.deltaOverall >= 0 ? "+" : ""}
                  {proj.deltaOverall} vs today
                </span>
                <div className="score-detail score-projection-note-inline">{proj.sourceNote}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Per-factor breakdown */}
      <div className="score-breakdown">
        {enabled.map(([key]) => {
          const factorScore = Math.round(analysisResult.factorScores[key]);
          const rawValue = analysisResult.raw_values?.[key];
          return (
            <div key={key} className="breakdown-row">
              <span className="breakdown-label">
                {key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
              </span>
              <span className="breakdown-vals">
                <span className="breakdown-score">{factorScore}</span>
                <span className="breakdown-diff">{rawValue.raw_value}</span>
              </span>
            </div>
          );
        })}
      </div>

      {proj && (
        <div className="score-breakdown score-breakdown-projection">
          <div className="score-breakdown-projection-heading">Projected factor scores ({proj.horizonYear})</div>
          {enabled.map(([key]) => {
            const ps = Math.round(proj.factorScores[key]);
            const cur = Math.round(analysisResult.factorScores[key]);
            const d = ps - cur;
            const rawValue = proj.raw_values?.[key];
            return (
              <div key={key} className="breakdown-row">
                <span className="breakdown-label">
                  {key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                </span>
                <span className="breakdown-vals">
                  <span className="breakdown-score">
                    {ps}
                    <span className="breakdown-delta-small">
                      {" "}
                      ({d >= 0 ? "+" : ""}
                      {d})
                    </span>
                  </span>
                  <span className="breakdown-diff">{rawValue?.raw_value}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
