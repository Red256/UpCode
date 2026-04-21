import { useState, useCallback, useEffect, useRef } from "react";
import MapView from "./components/MapView";
import AddressInput from "./components/AddressInput";
import FactorPanel, { FACTOR_DEFAULTS } from "./components/FactorPanel";
import ScoreCard from "./components/ScoreCard";
import { getVerdict } from "./utils/scoreVerdict";
import SavedLocations from "./components/SavedLocations";
import { generateLocationReport } from "./utils/reportGenerator";
import {
  fetchTractHeatmapGeoJson,
  HEATMAP_METRICS,
  isUsApprox,
} from "./utils/tractHeatmap";
import { fetchAreaMetrics, fetchCountyTrendForReport } from "./utils/censusApi";
import { ACS_HISTORY_YEARS } from "./utils/censusConstants";
import TractDetailPanel from "./components/TractDetailPanel";
import CelebrationOverlay from "./components/CelebrationOverlay";
import "./App.css";

/** Default search text + map seed (West Town / Ukrainian Village, Chicago) */
const DEFAULT_LOCATION =
  "1017, North Richmond Street, West Town, Chicago, West Chicago Township, Cook County, Illinois, 60622, United States";
const DEFAULT_CENTER = [41.9019, -87.6868];
const DEFAULT_POPUP = "1017 N Richmond St — West Town, Chicago";
const DEFAULT_ZOOM = 13;
const SCORE_BASE = 1.0;

function buildInitialFactors() {
  const out = {};
  FACTOR_DEFAULTS.forEach(({ key, defaultValue }) => {
    out[key] = { value: defaultValue, enabled: true };
  });
  return out;
}

function computeWeightedScore(factors, factorScores, factorRawValues) {
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

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem("savedLocationsV2")) || [];
  } catch {
    return [];
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && inQuotes) {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((s) => s.replace(/^"|"$/g, ""));
}

export default function App() {
  let [location, setLocation] = useState(DEFAULT_LOCATION);
  let [center, setCenter] = useState(DEFAULT_CENTER);
  let [zoom, setZoom] = useState(DEFAULT_ZOOM);
  let [radiusMi, setRadiusMi] = useState(5);
  let [popupText, setPopupText] = useState(DEFAULT_POPUP);
  let [factors, setFactors] = useState(buildInitialFactors);
  let [saved, setSaved] = useState(loadSaved);
  let [locationSet, setLocationSet] = useState(true);
  let [analyzed, setAnalyzed] = useState(false);
  let [analyzing, setAnalyzing] = useState(false);
  let [analysisResult, setAnalysisResult] = useState(null);
  let [suggestions, setSuggestions] = useState([]);
  const [heatmapGeoJson, setHeatmapGeoJson] = useState(null);
  const [heatmapMetric, setHeatmapMetric] = useState("Median Income");
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapError, setHeatmapError] = useState(null);
  const [selectedTract, setSelectedTract] = useState(null);
  const [celebrationBurst, setCelebrationBurst] = useState(0);
  const eliteConfettiPlayedRef = useRef(false);

  const heatmapField =
    HEATMAP_METRICS.find((m) => m.key === heatmapMetric)?.field ?? "income";

  /** Load tract choropleth whenever the map center / radius changes (default view included). */
  useEffect(() => {
    if (!isUsApprox(center[0], center[1])) {
      setHeatmapGeoJson(null);
      setHeatmapError("Tract heatmap only available for U.S. locations.");
      setHeatmapLoading(false);
      return;
    }
    let cancelled = false;
    setHeatmapError(null);
    (async () => {
      setHeatmapLoading(true);
      try {
        const fc = await fetchTractHeatmapGeoJson(center[0], center[1], radiusMi);
        if (cancelled) return;
        setHeatmapGeoJson(fc);
        setHeatmapError(null);
      } catch {
        if (!cancelled) {
          setHeatmapGeoJson({ type: "FeatureCollection", features: [] });
          setHeatmapError(null);
        }
      } finally {
        if (!cancelled) setHeatmapLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [center, radiusMi]);

  async function geocodeAddress(address) {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`
    );
    const data = await res.json();

    if (!data || data.length === 0) return null;

    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      displayName: data[0].display_name,
    };
  }

  /* Nearby suggestions feature disabled - would require additional Census API calls */

  const persistSaved = (list) => {
    setSaved(list);
    localStorage.setItem("savedLocationsV2", JSON.stringify(list));
  };
  
  const handleFactorChange = useCallback((key, value) => {
    setFactors((prev) => ({
      ...prev,
      [key]: { ...prev[key], value },
    }));
  }, []);

  const handleToggle = useCallback((key) => {
    setFactors((prev) => ({
      ...prev,
      [key]: { ...prev[key], enabled: !prev[key].enabled },
    }));
  }, []);

  const handleSelect = (item) => {
    setLocation(item.fullName);
    setCenter([item.lat, item.lng]);
    setZoom(12);
    setPopupText(item.fullName);
    setLocationSet(true);
  };

  const handleAnalyze = async () => {
    const enabled = Object.entries(factors).filter(([, f]) => f.enabled);
    if (enabled.length === 0) return;

    setAnalyzing(true);
    setAnalyzed(false);
    setAnalysisResult(null);
    setHeatmapGeoJson(null);
    setHeatmapError(null);
    setSelectedTract(null);
    setSuggestions([]);

    try {
      const geo = await geocodeAddress(location);
      if (!geo) {
        alert("Could not find that location. Please try a different address.");
        setAnalyzing(false);
        return;
      }
      const lat = geo.lat;
      const lng = geo.lng;

      setCenter([lat, lng]);
      setZoom(12);

      const areaData = await fetchAreaMetrics(lat, lng, radiusMi);

      const scores = areaData.scores;
      const raw_values = {};
      for (const key of Object.keys(scores)) {
        raw_values[key] = areaData.rawValues[key];
      }

      const weightedResult = computeWeightedScore(factors, scores, raw_values);
      if (!weightedResult) {
        setAnalyzing(false);
        return;
      }

      let projection = null;
      if (areaData.projection?.factorScores) {
        const projWeighted = computeWeightedScore(
          factors,
          areaData.projection.factorScores,
          areaData.projection.rawValues
        );
        if (projWeighted) {
          const hy = areaData.projection.historyYears;
          const fallbackYears = [...ACS_HISTORY_YEARS]
            .map((y) => parseInt(y, 10))
            .sort((a, b) => a - b);
          const ys =
            Array.isArray(hy) && hy.length > 0 ? [...hy].sort((a, b) => a - b) : fallbackYears;
          const range = ys.length ? `${ys[0]}–${ys[ys.length - 1]}` : "";
          const isTractAgg = areaData.projection.source === "tract_aggregate";
          const lead = isTractAgg
            ? "Projected from linear trends on tract-level ACS history"
            : "Projected from linear trends on county-level ACS history";
          const sourceNote = range
            ? `${lead} (${range}). Not a forecast of market cycles.`
            : `${lead}. Not a forecast of market cycles.`;
          projection = {
            horizonYear: areaData.projection.horizonYear,
            overall: projWeighted.overall,
            raw_values: projWeighted.breakdown,
            factorScores: areaData.projection.factorScores,
            deltaOverall: projWeighted.overall - weightedResult.overall,
            historyYears: areaData.projection.historyYears,
            sourceNote,
          };
        }
      }

      setAnalysisResult({
        factorScores: scores,
        overall: weightedResult.overall,
        raw_values: weightedResult.breakdown,
        tractCount: areaData.tractCount,
        dataSource: areaData.dataSource,
        acsDatasetYear: areaData.year,
        projection,
      });
      setAnalyzed(true);
      if (weightedResult.overall >= 85 && !eliteConfettiPlayedRef.current) {
        eliteConfettiPlayedRef.current = true;
        setCelebrationBurst((n) => n + 1);
      }
    } catch (err) {
      console.error("Analysis error:", err);
      alert(err.message || "Analysis failed. Please try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSave = () => {
    const score = analysisResult?.overall ?? null;
    if (score === null) return;

    const verdict = getVerdict(score);
    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      label: location.trim() || "Unnamed Location",
      lat: center[0],
      lng: center[1],
      radiusMi,
      score,
      verdict: verdict.text,
      savedAt: new Date().toISOString(),
    };

    persistSaved([entry, ...saved]);
  };

  const handleView = (s) => {
    setCenter([s.lat, s.lng]);
    setZoom(12);
    setRadiusMi(s.radiusMi);
    setPopupText(s.label);
    setLocation(s.label);
    setLocationSet(true);
  };

  const handleDelete = (id) => {
    persistSaved(saved.filter((s) => s.id !== id));
  };

  const handleSelectSuggestion = (suggestion) => {
    setLocation(suggestion.displayName);
    setCenter([suggestion.lat, suggestion.lng]);
    setZoom(12);
    setPopupText(suggestion.displayName);
    setLocationSet(true);
    setSuggestions([]);
    setAnalyzed(false);
    setAnalysisResult(null);
  };

  const handleExport = () => {
    const header = "label,lat,lng,radiusMi,score,verdict,savedAt\n";
    const rows = saved.map((s) => {
      const safeLabel = `"${String(s.label).replaceAll('"', '""')}"`;
      return [
        safeLabel,
        s.lat,
        s.lng,
        s.radiusMi,
        s.score,
        `"${String(s.verdict).replaceAll('"', '""')}"`,
        s.savedAt,
      ].join(",");
    });

    const csv = header + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "franchisefit_saved_locations.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const lines = text.split("\n").filter(Boolean);
      const rows = lines.slice(1);
      const newEntries = [];

      rows.forEach((line) => {
        const parts = parseCsvLine(line);
        if (!parts || parts.length < 7) return;
        const [label, lat, lng, rMi, score, verdict, savedAt] = parts;
        newEntries.push({
          id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
          label: label || "Imported Location",
          lat: Number(lat),
          lng: Number(lng),
          radiusMi: Number(rMi),
          score: Number(score),
          verdict: verdict || "Imported",
          savedAt: savedAt || new Date().toISOString(),
        });
      });

      persistSaved([...newEntries, ...saved]);
    };
    reader.readAsText(file);
  };

  const handleDownloadReport = async () => {
    if (!analysisResult) return;
    
    try {
      const { captureMapToDataUrl } = await import("./utils/mapCapture");
      const mapSnapshot = await captureMapToDataUrl(center, zoom);
      const trendData = await fetchCountyTrendForReport(center[1], center[0]);
      const pdf = await generateLocationReport(
        location,
        analysisResult,
        factors,
        radiusMi,
        center,
        suggestions,
        mapSnapshot,
        trendData
      );
      
      const filename = `FranchiseFit_Report_${location.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
      pdf.save(filename);
    } catch (error) {
      console.error('Error generating report:', error);
      alert('Failed to generate report. Please try again.');
    }
  };

  const enabledCount = Object.values(factors).filter((f) => f.enabled).length;
  const eliteScore =
    analyzed && analysisResult != null && analysisResult.overall >= 85;

  return (
    <div className={`app${eliteScore ? " app--elite-score" : ""}`}>
      <CelebrationOverlay burstKey={celebrationBurst} />
      <MapView
        center={center}
        zoom={zoom}
        radiusMi={radiusMi}
        popupText={popupText}
        heatmapData={heatmapGeoJson}
        heatmapMetric={heatmapMetric}
        heatmapField={heatmapField}
        heatmapLoading={heatmapLoading}
        heatmapError={heatmapError}
        onHeatmapMetricChange={setHeatmapMetric}
        onTractClick={setSelectedTract}
        eliteScore={eliteScore}
      />

      {selectedTract && (
        <TractDetailPanel
          tract={selectedTract}
          onClose={() => setSelectedTract(null)}
        />
      )}

      <div className={`panel${eliteScore ? " panel--elite" : ""}`}>
        {/* Header */}
        <div className="header">
          <div className="brand">
            <h1>FranchiseFit</h1>
            <p>Fast location scoring for franchise and SMB decisions.</p>
          </div>
          <div className="pill">
            <span className="pulse-dot" />
            Live Map
          </div>
        </div>

        {/* Location Controls */}
        <div className="card">
          <div className="card-label">Location</div>
          <div className="controls">
            <AddressInput
              value={location}
              onChange={(val) => {
                setLocation(val);
                if (!val.trim()) setLocationSet(false);
              }}
              onSelect={handleSelect}
            />
            <select
              value={radiusMi}
              onChange={(e) => setRadiusMi(Number(e.target.value))}
            >
              <option value={3}>3 mi</option>
              <option value={5}>5 mi</option>
              <option value={6}>6 mi</option>
            </select>
          </div>
          {locationSet && (
            <div className="location-confirmed">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span>Location pinned on map</span>
            </div>
          )}
        </div>

        {/* Toggleable Factors */}
        <FactorPanel
          factors={factors}
          onFactorChange={handleFactorChange}
          onToggle={handleToggle}
        />

        {/* Analyze button */}
        <div className="card">
          <button
            className="save-btn analyze-btn"
            onClick={handleAnalyze}
            disabled={enabledCount === 0 || analyzing}
          >
            {analyzing ? (
              <>
                <span className="spinner" />
                Analyzing...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Analyze Location
              </>
            )}
          </button>
        </div>

        {/* Score — only after analysis */}
        {analyzed && analysisResult && (
          <ScoreCard factors={factors} analysisResult={analysisResult} />
        )}

        {/* Nearby Suggestions */}
        {analyzed && suggestions.length > 0 && (
          <div className="card">
            <div className="card-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              Better Locations Nearby
            </div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '12px' }}>
              Found {suggestions.length} location{suggestions.length > 1 ? 's' : ''} with higher scores within 5 miles
            </div>
            {suggestions.map((suggestion, idx) => (
              <div
                key={idx}
                onClick={() => handleSelectSuggestion(suggestion)}
                style={{
                  padding: '12px',
                  background: '#f9fafb',
                  borderRadius: '8px',
                  marginBottom: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  border: '1px solid #e5e7eb'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#f3f4f6';
                  e.currentTarget.style.borderColor = '#d1d5db';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#f9fafb';
                  e.currentTarget.style.borderColor = '#e5e7eb';
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '14px', fontWeight: '500', color: '#111827', marginBottom: '4px' }}>
                      {suggestion.displayName.split(',').slice(0, 2).join(',')}
                    </div>
                    <div style={{ fontSize: '12px', color: '#6b7280' }}>
                      {suggestion.distance.toFixed(1)} mi away
                    </div>
                  </div>
                  <div style={{
                    fontSize: '18px',
                    fontWeight: '600',
                    color: suggestion.score >= 75 ? '#10b981' : suggestion.score >= 60 ? '#3b82f6' : '#6b7280',
                    marginLeft: '12px'
                  }}>
                    {suggestion.score}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Save button — only after analysis */}
        {analyzed && analysisResult && (
          <div className="card">
            <button
              className="save-btn"
              onClick={handleSave}
              disabled={enabledCount === 0}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              Save Location
            </button>
            <button
              className="save-btn"
              onClick={handleDownloadReport}
              style={{ 
                marginTop: '8px', 
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                boxShadow: '0 2px 8px rgba(16, 185, 129, 0.25)'
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <polyline points="9 15 12 18 15 15" />
              </svg>
              Download PDF Report
            </button>
          </div>
        )}

        {/* Saved Locations */}
        <SavedLocations
          saved={saved}
          onView={handleView}
          onDelete={handleDelete}
          onExport={handleExport}
          onImport={handleImport}
        />

        {/* Footer */}
        <div className="panel-footer">
          <span>FranchiseFit MVP</span>
          <span className="footer-dot" />
          <span>{enabledCount} of 5 factors active</span>
        </div>
      </div>
    </div>
  );
}
