import { useState, useCallback, useEffect, useRef } from "react";
import MapView from "./components/MapView";
import AddressInput from "./components/AddressInput";
import FactorPanel, { FACTOR_DEFAULTS } from "./components/FactorPanel";
import ScoreCard from "./components/ScoreCard";
import { generateLocationReport } from "./utils/reportGenerator";
import { geocodeUsAddressFreeform } from "./utils/usGeocode";
import { fetchTractHeatmapGeoJson, isUsApprox } from "./utils/tractHeatmap";
import { fetchAreaMetrics, fetchCountyTrendForReport } from "./utils/censusApi";
import { suggestLocationsInRadiusGradientDescent } from "./utils/locationSuggestions";
import { ACS_HISTORY_YEARS } from "./utils/censusConstants";
import TractDetailPanel from "./components/TractDetailPanel";
import CelebrationOverlay from "./components/CelebrationOverlay";
import Toast from "./components/Toast";
import { makeCirclePolygon } from "./utils/polygon";
import "./App.css";

/** Default search text + map seed (California Ave corridor, Palo Alto) */
const DEFAULT_LOCATION = "299 California Avenue, Palo Alto, California";
const DEFAULT_CENTER = [37.4284, -122.1438];
const DEFAULT_POPUP = "299 California Ave — Palo Alto, CA";
const DEFAULT_ZOOM = 13;

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

export default function App() {
  let [location, setLocation] = useState(DEFAULT_LOCATION);
  let [center, setCenter] = useState(DEFAULT_CENTER);
  let [zoom, setZoom] = useState(DEFAULT_ZOOM);
  let [radiusMi, setRadiusMi] = useState(5);
  let [popupText, setPopupText] = useState(DEFAULT_POPUP);
  let [factors, setFactors] = useState(buildInitialFactors);
  let [locationSet, setLocationSet] = useState(true);
  let [analyzed, setAnalyzed] = useState(false);
  let [analyzing, setAnalyzing] = useState(false);
  let [analysisResult, setAnalysisResult] = useState(null);
  let [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [heatmapGeoJson, setHeatmapGeoJson] = useState(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapError, setHeatmapError] = useState(null);
  /** Bumps when user picks a location so tract layer refetches even if center coords match a prior selection. */
  const [heatmapLoadGeneration, setHeatmapLoadGeneration] = useState(0);
  const [selectedTract, setSelectedTract] = useState(null);
  const [celebrationBurst, setCelebrationBurst] = useState(0);
  const eliteConfettiPlayedRef = useRef(false);
  const [toastVisible, setToastVisible] = useState(false);
  const prevAnalyzedRef = useRef(false);
  
  // Polygon tool state
  const [polygon, setPolygon] = useState(null);
  const [drawingMode, setDrawingMode] = useState(null); // null | "building"
  const [draftPolygon, setDraftPolygon] = useState(null);
  
  // Trigger toast when analysis transitions from running to done
  useEffect(() => {
    if (analyzed && !prevAnalyzedRef.current) {
      setToastVisible(true);
    }
    prevAnalyzedRef.current = analyzed;
  }, [analyzed]);

  /** Load tract features whenever the map center / radius / polygon changes (default view included). */
  useEffect(() => {
    if (!isUsApprox(center[0], center[1])) {
      setHeatmapGeoJson(null);
      setHeatmapError("Tract heatmap only available for U.S. locations.");
      setHeatmapLoading(false);
      return;
    }
    let cancelled = false;
    setHeatmapError(null);
    setHeatmapGeoJson(null);
    (async () => {
      setHeatmapLoading(true);
      try {
        const fc = await fetchTractHeatmapGeoJson(center[0], center[1], radiusMi, polygon);
        if (cancelled) return;
        setHeatmapGeoJson(fc);
        setHeatmapError(null);
      } catch (err) {
        console.error("Tract heatmap load error:", err);
        if (!cancelled) {
          // Don't show error, just use empty collection so app remains usable
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
  }, [center, radiusMi, heatmapLoadGeneration, polygon]);

  /* Nearby suggestions feature disabled - would require additional Census API calls */

  
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

  const handleSelectShape = useCallback((newPolygon) => {
    setPolygon(newPolygon);
    setDrawingMode(null);
    setDraftPolygon(null);
    setHeatmapLoadGeneration((g) => g + 1);
  }, []);

  const handleStartFreeDraw = useCallback(() => {
    setDrawingMode("building");
    setDraftPolygon([]);
  }, []);

  const handleCancelDrawing = useCallback(() => {
    setDrawingMode(null);
    setDraftPolygon(null);
  }, []);

  const handleFinishDrawing = useCallback(() => {
    if (draftPolygon && draftPolygon.length >= 3) {
      setPolygon(draftPolygon);
      setHeatmapLoadGeneration((g) => g + 1);
    }
    setDrawingMode(null);
    setDraftPolygon(null);
  }, [draftPolygon]);

  const handlePolygonChange = useCallback((newPolygon) => {
    setPolygon(newPolygon);
    setHeatmapLoadGeneration((g) => g + 1);
  }, []);

  const handleClearPolygon = useCallback(() => {
    const circleShape = makeCirclePolygon(center, radiusMi, 32);
    setPolygon(circleShape);
    setHeatmapLoadGeneration((g) => g + 1);
  }, [center, radiusMi]);

  const handleSelect = async (item) => {
    setLocation(item.fullName);
    setPopupText(item.fullName);
    setLocationSet(true);
    setZoom(12);
    setHeatmapError(null);
    setHeatmapGeoJson(null);
    setHeatmapLoading(true);

    const geo = await geocodeUsAddressFreeform(item.fullName);
    const lat = geo?.lat ?? item.lat;
    const lng = geo?.lng ?? item.lng;
    setCenter([Number(lat), Number(lng)]);
    setHeatmapLoadGeneration((g) => g + 1);
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
    setSuggestionsLoading(false);

    try {
      const geo = await geocodeUsAddressFreeform(location);
      if (!geo) {
        alert("Could not find that location. Please try a different address.");
        setAnalyzing(false);
        return;
      }
      const lat = geo.lat;
      const lng = geo.lng;

      setCenter([lat, lng]);
      setZoom(12);

      const areaData = await fetchAreaMetrics(lat, lng, radiusMi, undefined, polygon);

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

      // Background: in-radius search + verify (matches Analyze scores)
      buildLocationSuggestions(lat, lng, radiusMi, factors, areaData.tractGeoJson, polygon).catch(console.error);
    } catch (err) {
      console.error("Analysis error:", err);
      alert(err.message || "Analysis failed. Please try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  async function buildLocationSuggestions(centerLat, centerLng, radiusMi, factors, tractGeoJson, polygonLatLng = null) {
    setSuggestionsLoading(true);
    try {
      const top = await suggestLocationsInRadiusGradientDescent({
        centerLat,
        centerLng,
        radiusMi,
        factors,
        tractGeoJson,
        topN: 5,
      });
      /** Same pipeline as Analyze: area aggregate for this pin + radius (tract-at-point was only for search). */
      const verified = await Promise.all(
        top.map(async (loc) => {
          try {
            const areaData = await fetchAreaMetrics(loc.lat, loc.lng, radiusMi, undefined, polygonLatLng);
            const weightedResult = computeWeightedScore(factors, areaData.scores, areaData.rawValues);
            if (weightedResult) {
              return { ...loc, score: weightedResult.overall };
            }
          } catch (e) {
            console.warn("Suggestion score verify failed:", e);
          }
          return loc;
        }),
      );
      verified.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      setSuggestions(verified);
    } finally {
      setSuggestionsLoading(false);
    }
  }

  const handleSelectSuggestion = (suggestion) => {
    setLocation(suggestion.displayName || `${suggestion.lat.toFixed(4)}, ${suggestion.lng.toFixed(4)}`);
    setCenter([suggestion.lat, suggestion.lng]);
    setZoom(14);
    setPopupText(suggestion.displayName || `${suggestion.lat.toFixed(4)}, ${suggestion.lng.toFixed(4)}`);
    setLocationSet(true);
    setHeatmapError(null);
    setHeatmapGeoJson(null);
    setHeatmapLoading(true);
    setHeatmapLoadGeneration((g) => g + 1);
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
  const wideLayout = analyzing || analyzed;

  return (
    <div className={`app${eliteScore ? " app--elite-score" : ""}${wideLayout ? " app--analyzed" : ""}`}>
      <CelebrationOverlay burstKey={celebrationBurst} />

      <MapView
        center={center}
        zoom={zoom}
        radiusMi={radiusMi}
        popupText={popupText}
        heatmapData={heatmapGeoJson}
        heatmapLoading={heatmapLoading}
        heatmapError={heatmapError}
        factors={factors}
        onTractClick={setSelectedTract}
        eliteScore={eliteScore}
        polygon={polygon}
        drawingMode={drawingMode}
        draftPolygon={draftPolygon}
        onPolygonChange={handlePolygonChange}
        onDraftChange={setDraftPolygon}
        onExitDrawing={handleCancelDrawing}
        onSelectShape={handleSelectShape}
        onStartFreeDraw={handleStartFreeDraw}
        onCancelDrawing={handleCancelDrawing}
        onFinishDrawing={handleFinishDrawing}
        onClearPolygon={polygon ? handleClearPolygon : null}
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

        {/* Nearby suggestions (same list as former left panel) */}
        {analyzed && (
          <div className="card">
            <div className="card-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              Better Locations Nearby
            </div>
            {suggestions.length > 0 ? (
              <>
                <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '12px' }}>
                  Found {suggestions.length} location{suggestions.length > 1 ? 's' : ''} with higher scores within your search radius
                </div>
                {suggestions.map((suggestion, idx) => (
                  <div
                    key={`${suggestion.lat}-${suggestion.lng}-${idx}`}
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
                          {(suggestion.displayName || `${suggestion.lat?.toFixed(4)}, ${suggestion.lng?.toFixed(4)}`)
                            .split(',')
                            .slice(0, 2)
                            .join(',')}
                        </div>
                        <div style={{ fontSize: '12px', color: '#6b7280' }}>
                          {typeof suggestion.distance === 'number' && !Number.isNaN(suggestion.distance)
                            ? `${suggestion.distance.toFixed(1)} mi from pin`
                            : '—'}
                        </div>
                      </div>
                      <div style={{
                        fontSize: '18px',
                        fontWeight: '600',
                        color:
                          (suggestion.score ?? 0) >= 75
                            ? '#10b981'
                            : (suggestion.score ?? 0) >= 60
                              ? '#3b82f6'
                              : '#6b7280',
                        marginLeft: '12px'
                      }}>
                        {suggestion.score ?? '—'}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '24px 12px',
                  color: '#6b7280',
                }}
              >
                {suggestionsLoading && <span className="spinner" />}
                <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#111827' }}>Loading</p>
              </div>
            )}
          </div>
        )}

        {/* Download report — only after analysis */}
        {analyzed && analysisResult && (
          <div className="card">
            <button
              className="save-btn"
              onClick={handleDownloadReport}
              style={{ 
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

        {/* Footer */}
        <div className="panel-footer">
          <span>FranchiseFit MVP</span>
          <span className="footer-dot" />
          <span>
            {enabledCount} of {FACTOR_DEFAULTS.length} factors active
          </span>
        </div>
      </div>

      <Toast
        visible={toastVisible}
        onClose={() => setToastVisible(false)}
        message="Analysis complete"
        subMessage={
          suggestions.length > 0
            ? `${suggestions.length} recommendation${suggestions.length === 1 ? "" : "s"} identified`
            : analysisResult
              ? `Score: ${analysisResult.overall}/100`
              : "Results ready"
        }
      />
    </div>
  );
}
