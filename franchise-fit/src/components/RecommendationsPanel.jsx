function getVerdict(score) {
  if (score >= 85) return { text: "Excellent", cls: "ok", color: "#16a34a" };
  if (score >= 75) return { text: "Strong", cls: "ok", color: "#22c55e" };
  if (score >= 65) return { text: "Moderate", cls: "warn", color: "#f59e0b" };
  return { text: "Risky", cls: "bad", color: "#ef4444" };
}

function recommendationPrimaryLabel(loc) {
  const shorten = (s) =>
    s
      ? s
          .split(",")
          .slice(0, 3)
          .join(",")
          .trim()
      : "";
  if (loc.geocodedLabel) return shorten(loc.geocodedLabel);
  if (loc.displayName) return shorten(loc.displayName);
  if (!loc.geocodeResolved) return "Looking up address…";
  return "Address unavailable";
}

export default function RecommendationsPanel({
  topLocations,
  onLocationClick,
  analyzing,
  analyzed,
  onBackToAnalysis,
}) {
  return (
    <aside className="recommendations-panel">
      <div className="rec-header">
        <div>
          <h2 className="rec-title">Recommended Locations</h2>
          <p className="rec-subtitle">
            {topLocations.length > 0
              ? `Top ${topLocations.length} highest-scoring spots`
              : "Ranked candidates near your search"}
          </p>
        </div>
        {topLocations.length > 0 && (
          <span className="rec-count">{topLocations.length}</span>
        )}
      </div>

      {onBackToAnalysis && (
        <button type="button" className="view-switch-btn view-switch-btn--back" onClick={onBackToAnalysis}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M11 19l-7-7 7-7" />
          </svg>
          <span>Back to analysis</span>
        </button>
      )}

      {analyzing && (
        <div className="rec-empty">
          <span className="rec-spinner" />
          <p>Finding candidates…</p>
          <p className="rec-empty-sub">Searching nearby tracts and scoring each pin</p>
        </div>
      )}

      {!analyzing && !analyzed && (
        <div className="rec-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <p>No analysis yet</p>
          <p className="rec-empty-sub">Run analysis to see recommendations here</p>
        </div>
      )}

      {!analyzing && analyzed && topLocations.length === 0 && (
        <div className="rec-empty">
          <p>No ranked alternatives yet</p>
          <p className="rec-empty-sub">
            Try a wider radius or different weights — nothing scored higher in this search area.
          </p>
        </div>
      )}

      {topLocations.length > 0 && (
        <ul className="rec-list">
          {topLocations.map((loc) => {
            const verdict = getVerdict(loc.score ?? 0);
            const lon = loc.lon ?? loc.lng;
            return (
              <li key={`${loc.lat}-${lon}-${loc.rank}`}>
                <button
                  type="button"
                  className="rec-item"
                  onClick={() => onLocationClick(loc)}
                >
                  <div
                    className="rec-rank"
                    style={{
                      background: verdict.color,
                    }}
                  >
                    {loc.rank}
                  </div>
                  <div className="rec-body">
                    <div className="rec-row-top">
                      <div className="rec-place-block">
                        <span className="rec-place-primary">{recommendationPrimaryLabel(loc)}</span>
                        {typeof loc.distance === "number" && !Number.isNaN(loc.distance) && (
                          <span className="rec-distance">{loc.distance.toFixed(1)} mi from search pin</span>
                        )}
                      </div>
                      <span
                        className="rec-verdict"
                        style={{
                          color: verdict.color,
                          background: verdict.color + "14",
                          borderColor: verdict.color + "33",
                        }}
                      >
                        {verdict.text}
                      </span>
                    </div>
                    <div className="rec-row-mid">
                      <span className="rec-score">{Math.round(loc.score ?? 0)}</span>
                      <span className="rec-score-label">/100</span>
                    </div>
                    <div className="rec-subscores">
                      <SubScore label="Inc" score={loc.income_score} />
                      <SubScore label="Rent" score={loc.rent_score} />
                      <SubScore label="Home" score={loc.home_value_score} />
                      <SubScore label="Sch" score={loc.school_score} />
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function SubScore({ label, score }) {
  return (
    <div className="rec-subscore">
      <span className="rec-subscore-label">{label}</span>
      <span className="rec-subscore-value">
        {score != null && !Number.isNaN(Number(score)) ? Math.round(Number(score)) : "—"}
      </span>
    </div>
  );
}
