const FACTOR_DEFAULTS = [
  { key: "Median Income", label: "Median Income", icon: "dollar", defaultValue: 75 },
  { key: "Median Rent", label: "Median Rent", icon: "building", defaultValue: 70 },
  { key: "Median Home Value", label: "Median Home Value", icon: "home", defaultValue: 72 },
  { key: "Student Density", label: "Student Density", icon: "book", defaultValue: 80 },
];

export { FACTOR_DEFAULTS };

function FactorIcon({ icon }) {
  const icons = {
    dollar: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
      </svg>
    ),
    building: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2" /><path d="M9 22v-4h6v4" /><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01" />
      </svg>
    ),
    home: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
    users: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
    book: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
      </svg>
    ),
  };
  return icons[icon] || null;
}

export default function FactorPanel({ factors, onFactorChange, onToggle }) {
  return (
    <div className="card">
      <div className="card-label">Scoring Factors</div>
      <div className="factors">
        {FACTOR_DEFAULTS.map(({ key, label, icon }) => {
          const f = factors[key];
          const sliderBlue = "#2563eb";
          return (
            <div
              key={key}
              className={`factor-row ${!f.enabled ? "disabled" : ""}`}
            >
              <div className="factor-header">
                <div className="factor-left">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={f.enabled}
                      onChange={() => onToggle(key)}
                    />
                    <span className="toggle-slider" />
                  </label>
                  <span className="factor-icon">
                    <FactorIcon icon={icon} />
                  </span>
                  <span className="name">{label}</span>
                </div>
                <span className="val" style={{ color: f.enabled ? sliderBlue : undefined }}>
                  {f.enabled ? `${f.value}% wt` : "--"}
                </span>
              </div>
              <div className="slider-track-wrap">
                <input
                  type="range"
                  className="factor-slider"
                  min="0"
                  max="100"
                  value={f.value}
                  disabled={!f.enabled}
                  onChange={(e) => onFactorChange(key, Number(e.target.value))}
                  style={{
                    "--slider-pct": `${f.value}%`,
                    "--slider-color": f.enabled ? sliderBlue : "#94a3b8",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="small">
        Toggle factors on or off and drag sliders to set how heavily each factor
        should influence the final score.
      </p>
    </div>
  );
}
