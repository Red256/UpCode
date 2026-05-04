import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Circle, CircleMarker, Popup, useMap } from "react-leaflet";
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

export default function MapView({
  center,
  zoom,
  radiusMi,
  popupText,
  heatmapData = null,
  heatmapLoading = false,
  heatmapError = null,
  factors,
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
  const hasFeatures = heatmapData?.features?.length > 0;
  /** Show either tract polygons (choropleth) or kriging raster — not both. */
  const [tractSurfaceMode, setTractSurfaceMode] = useState(/** @type {'choropleth' | 'kriging'} */ ("choropleth"));
  /** Which score drives fill / kriging colors. */
  const [choroplethMetric, setChoroplethMetric] = useState(CHOROPLETH_METRIC_WEIGHTED);

  return (
    <div
      id={MAP_CAPTURE_ROOT_ID}
      className={`map-container${eliteScore ? " map-container--elite" : ""}`}
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
              Score heatmap
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

        <PolygonEditor
          polygon={polygon}
          drawingMode={drawingMode}
          draftPolygon={draftPolygon}
          onPolygonChange={onPolygonChange}
          onDraftChange={onDraftChange}
          onExitDrawing={onExitDrawing}
        />

        {hasFeatures && factors && (
          <TractScoreHeatmapLayer
            data={heatmapData}
            factors={factors}
            onTractClick={onTractClick}
            analysisCenter={center}
            analysisRadiusMi={radiusMi}
            surfaceMode={tractSurfaceMode}
            choroplethMetric={choroplethMetric}
            disableInteraction={drawingMode === "building"}
          />
        )}

        <CircleMarker
          center={center}
          radius={7}
          pathOptions={{
            color: "#1d4ed8",
            fillColor: "#ffffff",
            fillOpacity: 1,
            weight: 3,
          }}
        >
          {popupText && <Popup>{popupText}</Popup>}
        </CircleMarker>
      </MapContainer>

      {(heatmapLoading || heatmapError) && (
        <div className="heatmap-overlay" aria-live="polite">
          {heatmapLoading && <span className="heatmap-loading">Loading tract data…</span>}
          {heatmapError && <span className="heatmap-error">{heatmapError}</span>}
        </div>
      )}
    </div>
  );
}
