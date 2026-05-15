import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Circle, CircleMarker, Marker, Popup, useMap, Pane } from "react-leaflet";
import L from "leaflet";
import { BEFORE_MAP_CAPTURE, MAP_CAPTURE_ROOT_ID } from "../utils/mapConstants";
import { FACTOR_DEFAULTS } from "./FactorPanel";
import { CHOROPLETH_METRIC_WEIGHTED } from "../utils/tractOverallScore";
import TractScoreHeatmapLayer from "./TractScoreHeatmapLayer";
import PolygonEditor, { ShapeToolbar } from "./PolygonEditor";
import "leaflet/dist/leaflet.css";

function milesToMeters(mi) {
  return Number(mi) * 1609.344;
}

function MapUpdater({ center, zoom }) {
  const map = useMap();
  const prevCenter = useRef(center);

  useEffect(() => {
    if (
      center[0] !== prevCenter.current[0] ||
      center[1] !== prevCenter.current[1]
    ) {
      map.flyTo(center, zoom, { duration: 1.2 });
      prevCenter.current = center;
    }
  }, [center, zoom, map]);

  return null;
}

/** Leaflet must remeasure before html2canvas or overlays skew / look off-center in flex layouts */
function MapInvalidateForCapture() {
  const map = useMap();
  useEffect(() => {
    const handler = () => {
      map.invalidateSize({ animate: false });
    };
    document.addEventListener(BEFORE_MAP_CAPTURE, handler);
    return () => document.removeEventListener(BEFORE_MAP_CAPTURE, handler);
  }, [map]);
  return null;
}

/** Flex/layout/size changes (panel slide, window resize) require invalidateSize or overlays drift from tiles. */
function MapInvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    let raf = 0;
    const bump = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        map.invalidateSize({ animate: false });
      });
    };
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    window.addEventListener("resize", bump);
    bump();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", bump);
    };
  }, [map]);
  return null;
}

export default function MapView({
  center,
  zoom,
  radiusMi,
  popupText,
  heatmapData = null,
  heatmapLoading = false,
  heatmapError = null,
  factors,
  showReturnToAnalyzedSite = false,
  onReturnToAnalyzedSite,
  recommendationPins = [],
  onRecommendationPinClick,
  onTractClick,
  eliteScore = false,
  polygon = null,
  drawingMode = null,
  draftPolygon = null,
  onPolygonChange = () => {},
  onDraftChange = () => {},
  onExitDrawing = () => {},
  onSelectShape = () => {},
  onStartFreeDraw = () => {},
  onCancelDrawing = () => {},
  onFinishDrawing = () => {},
  onClearPolygon = null,
}) {
  const meters = milesToMeters(radiusMi);
  const isFreeDrawing = drawingMode === "building";
  const hasFeatures = heatmapData?.features?.length > 0;
  const recPins = Array.isArray(recommendationPins) ? recommendationPins : [];
  /** Score → color: green (great) → blue (good) → yellow (ok) → red (poor). */
  const recommendationPinColor = (score) => {
    const s = Number(score);
    if (!Number.isFinite(s)) return "#2563eb";
    if (s >= 85) return "#16a34a"; // green — excellent
    if (s >= 70) return "#2563eb"; // blue — good
    if (s >= 55) return "#f59e0b"; // yellow — ok
    return "#ef4444";              // red — poor
  };

  const recommendationPopupTitle = (rec) => {
    const short = (s) =>
      s
        ? s
            .split(",")
            .slice(0, 3)
            .join(",")
            .trim()
        : "";
    if (rec.geocodedLabel) return short(rec.geocodedLabel);
    if (rec.displayName) return short(rec.displayName);
    if (!rec.geocodeResolved) return "Looking up address…";
    return "Address unavailable";
  };

  /** Show either tract polygons (choropleth) or kriging raster — not both. */
  const [tractSurfaceMode, setTractSurfaceMode] = useState(/** @type {'choropleth' | 'kriging'} */ ("choropleth"));
  /** Which score drives fill / kriging colors. */
  const [choroplethMetric, setChoroplethMetric] = useState(CHOROPLETH_METRIC_WEIGHTED);

  return (
    <div
      id={MAP_CAPTURE_ROOT_ID}
      className={`map-container${eliteScore ? " map-container--elite" : ""}${isFreeDrawing ? " map-container--free-draw" : ""}`}
    >
      <ShapeToolbar
        center={center}
        presetSizeMi={radiusMi}
        onSelectShape={onSelectShape}
        onStartFreeDraw={onStartFreeDraw}
        drawingMode={drawingMode}
        draftCount={draftPolygon?.length || 0}
        onCancelDrawing={onCancelDrawing}
        onFinishDrawing={onFinishDrawing}
        onClear={onClearPolygon}
      />

      {hasFeatures && (
        <div className="heatmap-controls">
          <div className="heatmap-mode-toggle" role="group" aria-label="Tract layer display">
            <button
              type="button"
              className={tractSurfaceMode === "choropleth" ? "active" : ""}
              onClick={() => setTractSurfaceMode("choropleth")}
            >
              Choropleth
            </button>
            <button
              type="button"
              className={tractSurfaceMode === "kriging" ? "active" : ""}
              onClick={() => setTractSurfaceMode("kriging")}
            >
              Heatmap
            </button>
          </div>
          <label className="heatmap-metric-row">
            <span className="heatmap-metric-row__label">Color by</span>
            <select
              className="heatmap-metric-select"
              value={choroplethMetric}
              onChange={(e) => setChoroplethMetric(e.target.value)}
              aria-label="Metric for map colors"
            >
              <option value={CHOROPLETH_METRIC_WEIGHTED}>Weighted score (panel)</option>
              {FACTOR_DEFAULTS.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div
            className="heatmap-mode-label"
            title="Red = lower score, green = higher (same 0–100 scale as factor scores)."
          >
            {tractSurfaceMode === "choropleth"
              ? "Tract boundaries — click for tract details."
              : polygon?.length >= 3
                ? "Interpolated surface inside your custom zone (land only)."
                : "Interpolated surface from tract scores (search circle, land only)."}
          </div>
        </div>
      )}

      <MapContainer
        center={center}
        zoom={zoom}
        zoomControl={false}
        preferCanvas={false}
        style={{ width: "100%", height: "100%" }}
      >
        <TileLayer
          crossOrigin="anonymous"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
          attribution="&copy; OpenStreetMap"
        />
        <MapUpdater center={center} zoom={zoom} />
        <MapInvalidateForCapture />
        <MapInvalidateOnResize />

        {!polygon && (
          <Circle
            center={center}
            radius={meters}
            interactive={false}
            pathOptions={{
              color: "#2563eb",
              weight: 2,
              fillOpacity: 0.14,
            }}
          />
        )}

        {hasFeatures && factors && (
          <TractScoreHeatmapLayer
            data={heatmapData}
            factors={factors}
            onTractClick={onTractClick}
            analysisCenter={center}
            analysisRadiusMi={radiusMi}
            surfaceMode={tractSurfaceMode}
            choroplethMetric={choroplethMetric}
            disableInteraction={isFreeDrawing}
            analysisPolygonLatLng={polygon}
          />
        )}

        <PolygonEditor
          polygon={polygon}
          drawingMode={drawingMode}
          draftPolygon={draftPolygon}
          onPolygonChange={onPolygonChange}
          onDraftChange={onDraftChange}
          onExitDrawing={onExitDrawing}
        />

        {recPins.length > 0 ? (
          <Pane name="frFitRecommendationPins" style={{ zIndex: 640 }}>
            {recPins.map((rec) => {
              const lon = rec.lon ?? rec.lng;
              if (rec.lat == null || lon == null || Number.isNaN(rec.lat) || Number.isNaN(lon)) return null;
              const fill = recommendationPinColor(rec.score);
              const icon = L.divIcon({
                className: "rec-pin-icon",
                html: `<div class="rec-pin-badge" style="background:${fill}">${rec.rank ?? ""}</div>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13],
              });
              return (
                <Marker
                  key={`rec-pin-${rec.rank}-${rec.lat}-${lon}`}
                  position={[rec.lat, lon]}
                  icon={icon}
                  interactive={!isFreeDrawing}
                  eventHandlers={{
                    click: () => {
                      if (!isFreeDrawing && onRecommendationPinClick) onRecommendationPinClick(rec);
                    },
                  }}
                >
                  <Popup>
                    <div className="rec-map-popup">
                      <div className="rec-map-popup-rank">Recommendation #{rec.rank}</div>
                      <div className="rec-map-popup-place">{recommendationPopupTitle(rec)}</div>
                      {rec.score != null && !Number.isNaN(Number(rec.score)) && (
                        <div className="rec-map-popup-score">Score {Math.round(Number(rec.score))}/100</div>
                      )}
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </Pane>
        ) : null}

        <Pane name="frFitAnalysisCenterPin" style={{ zIndex: 650 }}>
          <CircleMarker
            center={center}
            radius={7}
            interactive={!isFreeDrawing}
            pathOptions={{
              color: "#1d4ed8",
              fillColor: "#ffffff",
              fillOpacity: 1,
              weight: 3,
            }}
          >
            {popupText && <Popup>{popupText}</Popup>}
          </CircleMarker>
        </Pane>
      </MapContainer>

      {(heatmapLoading || heatmapError || (heatmapLoading && heatmapData?.partial)) && (
        <div className="heatmap-overlay" aria-live="polite">
          {heatmapLoading && heatmapData?.partial ? (
            <span className="heatmap-loading">Loading census scores…</span>
          ) : heatmapLoading ? (
            <span className="heatmap-loading">Loading tract boundaries…</span>
          ) : null}
          {heatmapError && <span className="heatmap-error">{heatmapError}</span>}
        </div>
      )}

      {showReturnToAnalyzedSite && typeof onReturnToAnalyzedSite === "function" && (
        <button
          type="button"
          className="map-return-analyzed-btn"
          onClick={onReturnToAnalyzedSite}
          aria-label="Return to analyzed search location"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5" />
            <path d="M11 19l-7-7 7-7" />
          </svg>
          <span>Back to analyzed location</span>
        </button>
      )}
    </div>
  );
}
