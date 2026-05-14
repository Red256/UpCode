import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import MapView from "./components/MapView";
import AddressInput from "./components/AddressInput";
import FactorPanel, { FACTOR_DEFAULTS } from "./components/FactorPanel";
import ScoreCard from "./components/ScoreCard";
import { generateLocationReport } from "./utils/reportGenerator";
import { geocodeUsAddressFreeform, reverseGeocodeLatLng } from "./utils/usGeocode";
import { fetchTractHeatmapGeoJson, isUsApprox } from "./utils/tractHeatmap";
import { fetchAreaMetrics, fetchCountyTrendForReport } from "./utils/censusApi";
import { suggestLocationsInRadiusGradientDescent } from "./utils/locationSuggestions";
import { ACS_HISTORY_YEARS } from "./utils/censusConstants";
import {
  computeWeightedScore,
  metricRawValuesFromBreakdown,
} from "./utils/weightedAreaScore";
import { isHttpRateLimitError } from "./utils/httpErrors";
import TractDetailPanel from "./components/TractDetailPanel";
import CelebrationOverlay from "./components/CelebrationOverlay";
import Toast from "./components/Toast";
import RecommendationsPanel from "./components/RecommendationsPanel";
import "./App.css";

/** Census factor keys → RecommendationsPanel sub-score props */
function attachRecommendationSubscores(areaScores) {
  return {
    income_score: areaScores["Median Income"],
    rent_score: areaScores["Median Rent"],
    home_value_score: areaScores["Median Home Value"],
    student_density_score: areaScores["Student Density"],
  };
}

/** Default search text + map seed (California Ave corridor, Palo Alto) */
const DEFAULT_LOCATION = "299 California Avenue, Palo Alto, California";
const DEFAULT_CENTER = [37.4284, -122.1438];
const DEFAULT_POPUP = "299 California Ave — Palo Alto, CA";
const DEFAULT_ZOOM = 13;

/** If geocode moves the pin this far from the current center, drop custom polygon (shape was for the old location). */
const RESET_SHAPE_IF_PIN_MOVED_MI = 0.75;

function pinMovedEnoughToResetShape(prevLat, prevLng, nextLat, nextLng, thresholdMi = RESET_SHAPE_IF_PIN_MOVED_MI) {
  const dLat = (nextLat - prevLat) * 69;
  const dLng = (nextLng - prevLng) * 69 * Math.cos((prevLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng) >= thresholdMi;
}

function buildInitialFactors() {
  const out = {};
  FACTOR_DEFAULTS.forEach(({ key, defaultValue }) => {
    out[key] = { value: defaultValue, enabled: true };
  });
  return out;
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
  /** Monotonic id so stale in-flight tract loads cannot commit after a newer load superseded them. */
  const heatmapFetchSeqRef = useRef(0);
  const [selectedTract, setSelectedTract] = useState(null);
  const [celebrationBurst, setCelebrationBurst] = useState(0);
  const eliteConfettiPlayedRef = useRef(false);
  const [toastVisible, setToastVisible] = useState(false);
  const prevAnalyzedRef = useRef(false);
  /** Side panel: analysis controls vs ranked recommendations (same scoring pipeline). */
  const [resultView, setResultView] = useState(/** @type {'analysis' | 'recommendations'} */ ("analysis"));
  /** Pin / map view from last successful Analyze — restored after visiting a recommendation. */
  const [analysisSiteSnapshot, setAnalysisSiteSnapshot] = useState(
    /** @type {{ center: [number, number], zoom: number, location: string, popupText: string } | null} */ (null),
  );
  /** True after user jumps map to a recommendation (until they return to the analyzed site). */
  const [viewingRecommendationSite, setViewingRecommendationSite] = useState(false);

  // Polygon tool state
  const [polygon, setPolygon] = useState(null);
  const [drawingMode, setDrawingMode] = useState(null); // null | "building"
  const [draftPolygon, setDraftPolygon] = useState(null);

  /** Recompute overall + projection from cached factor scores whenever weights/toggles change. */
  const weightedAnalysisResult = useMemo(() => {
    if (!analysisResult) return null;
    const metricRaw =
      analysisResult.metricRawValues ??
      metricRawValuesFromBreakdown(analysisResult.raw_values);
    const weighted = computeWeightedScore(factors, analysisResult.factorScores, metricRaw);
    if (!weighted) {
      return { ...analysisResult };
    }
    const next = {
      ...analysisResult,
      overall: weighted.overall,
      raw_values: weighted.breakdown,
    };
    const proj = analysisResult.projection;
    if (proj?.factorScores) {
      const projRaw =
        proj.projectionMetricRawValues ?? metricRawValuesFromBreakdown(proj.raw_values);
      const pw = computeWeightedScore(factors, proj.factorScores, projRaw);
      if (pw) {
        next.projection = {
          ...proj,
          overall: pw.overall,
          raw_values: pw.breakdown,
          deltaOverall: pw.overall - weighted.overall,
        };
      }
    }
    return next;
  }, [analysisResult, factors]);

  // Trigger toast when analysis transitions from running to done
  useEffect(() => {
    if (analyzed && !prevAnalyzedRef.current) {
      setToastVisible(true);
    }
    prevAnalyzedRef.current = analyzed;
  }, [analyzed]);

  /** Load tract features whenever the map center / radius / polygon changes (default view included). */
  useEffect(() => {
    const seq = ++heatmapFetchSeqRef.current;
    if (!isUsApprox(center[0], center[1])) {
      setHeatmapGeoJson(null);
      setHeatmapError("Tract heatmap only available for U.S. locations.");
      setHeatmapLoading(false);
      return;
    }
    let cancelled = false;
    setHeatmapError(null);
    setHeatmapGeoJson(null); // Clear old data immediately
    (async () => {
      setHeatmapLoading(true);
      try {
        const fc = await fetchTractHeatmapGeoJson(center[0], center[1], radiusMi, polygon, {
          onProgress: (partial) => {
            if (cancelled || seq !== heatmapFetchSeqRef.current) return;
            setHeatmapGeoJson(partial);
            // Keep loading state true during partial load
          },
        });
        if (cancelled || seq !== heatmapFetchSeqRef.current) return;
        setHeatmapGeoJson(fc);
        setHeatmapError(null);
      } catch (err) {
        console.error("Tract heatmap load error:", err);
        if (!cancelled && seq === heatmapFetchSeqRef.current) {
          setHeatmapGeoJson({ type: "FeatureCollection", features: [] });
          setHeatmapError(
            isHttpRateLimitError(err)
              ? err.message
              : "Tract map could not be loaded. Check your connection or try again in a moment.",
          );
        }
      } finally {
        if (!cancelled && seq === heatmapFetchSeqRef.current) {
          setHeatmapLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [center, radiusMi, heatmapLoadGeneration, polygon]);

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

  /** New pin / address → drop custom polygon so analysis matches default search circle */
  const resetCustomShapeSelection = useCallback(() => {
    setPolygon(null);
    setDrawingMode(null);
    setDraftPolygon(null);
  }, []);

  const handleStartFreeDraw = useCallback(() => {
    setSelectedTract(null);
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
    setPolygon(null);
    setDrawingMode(null);
    setDraftPolygon(null);
    setHeatmapLoadGeneration((g) => g + 1);
  }, []);

  const handleSelect = async (item) => {
    resetCustomShapeSelection();
    setSuggestions([]);
    setSuggestionsLoading(false);
    setViewingRecommendationSite(false);
    setResultView("analysis");
    setLocation(item.fullName);
    setPopupText(item.fullName);
    setLocationSet(true);
    setZoom(12);
    setHeatmapError(null);
    setHeatmapLoading(true);

    try {
      const geo = await geocodeUsAddressFreeform(item.fullName);
      const lat = geo?.lat ?? item.lat;
      const lng = geo?.lng ?? item.lng;
      setCenter([Number(lat), Number(lng)]);
      setHeatmapLoadGeneration((g) => g + 1);
    } catch (err) {
      setHeatmapLoading(false);
      if (isHttpRateLimitError(err)) {
        alert(err.message);
      } else {
        console.error(err);
        alert(err?.message || "Could not look up that address.");
      }
      setCenter([Number(item.lat), Number(item.lng)]);
      setHeatmapLoadGeneration((g) => g + 1);
    }
  };

  const handleAnalyze = async () => {
    const enabled = Object.entries(factors).filter(([, f]) => f.enabled);
    if (enabled.length === 0) return;

    setAnalyzing(true);
    setResultView("analysis");
    setAnalyzed(false);
    setAnalysisResult(null);
    setHeatmapError(null);
    setSelectedTract(null);
    setSuggestions([]);
    setSuggestionsLoading(false);
    setAnalysisSiteSnapshot(null);
    setViewingRecommendationSite(false);

    try {
      const geo = await geocodeUsAddressFreeform(location);
      if (!geo) {
        alert("Could not find that location. Please try a different address.");
        setAnalyzing(false);
        return;
      }
      const lat = geo.lat;
      const lng = geo.lng;

      let polygonForMetrics = polygon;
      if (pinMovedEnoughToResetShape(center[0], center[1], lat, lng)) {
        resetCustomShapeSelection();
        polygonForMetrics = null;
      }

      setCenter([lat, lng]);
      setZoom(12);

      const areaData = await fetchAreaMetrics(lat, lng, radiusMi, undefined, polygonForMetrics);

      const scores = areaData.scores;
      const raw_values = {};
      for (const key of Object.keys(scores)) {
        raw_values[key] = areaData.rawValues[key];
      }
      const metricRawValues = { ...areaData.rawValues };

      const weightedResult = computeWeightedScore(factors, scores, raw_values);
      if (!weightedResult) {
        setAnalyzing(false);
        return;
      }

      let projection = null;
      if (areaData.projection?.factorScores) {
        const projectionMetricRawValues = { ...areaData.projection.rawValues };
        const projWeighted = computeWeightedScore(
          factors,
          areaData.projection.factorScores,
          projectionMetricRawValues,
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
            projectionMetricRawValues,
          };
        }
      }

      setAnalysisResult({
        factorScores: scores,
        overall: weightedResult.overall,
        raw_values: weightedResult.breakdown,
        metricRawValues,
        tractCount: areaData.tractCount,
        dataSource: areaData.dataSource,
        acsDatasetYear: areaData.year,
        projection,
      });
      const pinLabel = (geo.displayName || location).trim();
      setAnalysisSiteSnapshot({
        center: [lat, lng],
        zoom: 12,
        location: location.trim(),
        popupText: pinLabel,
      });
      setAnalyzed(true);
      if (weightedResult.overall >= 85 && !eliteConfettiPlayedRef.current) {
        eliteConfettiPlayedRef.current = true;
        setCelebrationBurst((n) => n + 1);
      }

      // Background: in-radius search + verify (matches Analyze scores)
      buildLocationSuggestions(lat, lng, radiusMi, factors, areaData.tractGeoJson, polygonForMetrics).catch(
        console.error,
      );
    } catch (err) {
      console.error("Analysis error:", err);
      if (isHttpRateLimitError(err)) {
        alert(err.message);
      } else {
        alert(err.message || "Analysis failed. Please try again.");
      }
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
              return {
                ...loc,
                lon: loc.lng,
                score: weightedResult.overall,
                ...attachRecommendationSubscores(areaData.scores),
              };
            }
          } catch (e) {
            console.warn("Suggestion score verify failed:", e);
          }
          return loc;
        }),
      );
      const sorted = [...verified].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const ranked = sorted.map((row, i) => ({
        ...row,
        rank: i + 1,
        geocodedLabel: null,
        geocodeResolved: false,
      }));
      setSuggestions(ranked);
      ranked.forEach((row) => {
        reverseGeocodeLatLng(row.lat, row.lng).then((hit) => {
          setSuggestions((prev) =>
            prev.map((s) =>
              s.rank === row.rank && s.lat === row.lat && s.lng === row.lng
                ? { ...s, geocodedLabel: hit?.displayName ?? null, geocodeResolved: true }
                : s,
            ),
          );
        });
      });
    } finally {
      setSuggestionsLoading(false);
    }
  }

  const handleReturnToAnalyzedSite = useCallback(() => {
    const snap = analysisSiteSnapshot;
    if (!snap) return;
    setSelectedTract(null);
    setResultView("analysis");
    setCenter([snap.center[0], snap.center[1]]);
    setZoom(snap.zoom);
    setLocation(snap.location);
    setPopupText(snap.popupText);
    setLocationSet(true);
    setViewingRecommendationSite(false);
    setHeatmapError(null);
    setHeatmapLoading(true);
    setHeatmapLoadGeneration((g) => g + 1);
  }, [analysisSiteSnapshot]);

  const handleSelectSuggestion = (suggestion) => {
    setResultView("analysis");
    setSelectedTract(null);
    resetCustomShapeSelection();
    const lat = Number(suggestion.lat);
    const lng = Number(suggestion.lng ?? suggestion.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.warn("Recommendation missing coordinates:", suggestion);
      return;
    }
    const shortTitle = (s) =>
      s
        ? s
            .split(",")
            .slice(0, 3)
            .join(",")
            .trim()
        : "";
    let label;
    if (suggestion.geocodedLabel) {
      label = shortTitle(suggestion.geocodedLabel);
    } else if (suggestion.displayName) {
      label = shortTitle(suggestion.displayName);
    } else if (!suggestion.geocodeResolved) {
      label = "Recommendation";
    } else {
      label = "Address unavailable for this pin";
    }
    setLocation(label);
    setCenter([lat, lng]);
    setZoom(14);
    setPopupText(label);
    setLocationSet(true);
    setViewingRecommendationSite(true);
    setHeatmapError(null);
    setHeatmapLoading(true);
    setHeatmapLoadGeneration((g) => g + 1);
  };

  const handleDownloadReport = async () => {
    if (!weightedAnalysisResult) return;

    try {
      const { captureMapToDataUrl } = await import("./utils/mapCapture");
      const mapSnapshot = await captureMapToDataUrl(center, zoom);
      const trendData = await fetchCountyTrendForReport(center[1], center[0]);
      const pdf = await generateLocationReport(
        location,
        weightedAnalysisResult,
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
    analyzed && weightedAnalysisResult != null && weightedAnalysisResult.overall >= 85;
  const wideLayout = analyzing || analyzed;
  const showRecommendationsChrome = analyzed && resultView === "recommendations";

  return (
    <div
      className={`app${eliteScore ? " app--elite-score" : ""}${wideLayout ? " app--analyzed" : ""}`}
      data-view={wideLayout ? resultView : undefined}
    >
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
        showReturnToAnalyzedSite={analyzed && viewingRecommendationSite && Boolean(analysisSiteSnapshot)}
        onReturnToAnalyzedSite={handleReturnToAnalyzedSite}
        recommendationPins={analyzed ? suggestions : []}
        onRecommendationPinClick={handleSelectSuggestion}
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

      {wideLayout && (
        <RecommendationsPanel
          topLocations={suggestions}
          analyzing={suggestionsLoading}
          analyzed={analyzed}
          onLocationClick={handleSelectSuggestion}
          onBackToAnalysis={() => setResultView("analysis")}
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
        {analyzed && weightedAnalysisResult && (
          <ScoreCard factors={factors} analysisResult={weightedAnalysisResult} />
        )}

        {analyzed && weightedAnalysisResult && !showRecommendationsChrome && (
          <div className="card">
            <button
              type="button"
              className="view-switch-btn"
              onClick={() => setResultView("recommendations")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span>View recommendations</span>
            </button>
          </div>
        )}

        {/* Download report — only after analysis */}
        {analyzed && weightedAnalysisResult && (
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
            : weightedAnalysisResult
              ? `Score: ${weightedAnalysisResult.overall}/100`
              : "Results ready"
        }
      />
    </div>
  );
}
