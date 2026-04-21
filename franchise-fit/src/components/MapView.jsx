import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Circle, CircleMarker, Popup, useMap } from "react-leaflet";
import { BEFORE_MAP_CAPTURE, MAP_CAPTURE_ROOT_ID } from "../utils/mapConstants";
import TractHeatmapLayer from "./TractHeatmapLayer";
import { HEATMAP_METRICS } from "../utils/tractHeatmap";
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
  heatmapMetric = "Median Income",
  heatmapField = "income",
  heatmapLoading = false,
  heatmapError = null,
  onHeatmapMetricChange,
  onTractClick,
  eliteScore = false,
}) {
  const meters = milesToMeters(radiusMi);

  return (
    <div
      id={MAP_CAPTURE_ROOT_ID}
      className={`map-container${eliteScore ? " map-container--elite" : ""}`}
    >
      <MapContainer
        center={center}
        zoom={zoom}
        zoomControl={true}
        preferCanvas={true}
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
        {heatmapData?.features?.length > 0 && (
          <TractHeatmapLayer data={heatmapData} metricField={heatmapField} onTractClick={onTractClick} />
        )}
        <Circle
          center={center}
          radius={meters}
          pathOptions={{
            color: "#2563eb",
            weight: 2,
            fillOpacity: 0.14,
          }}
        >
          {popupText && <Popup>{popupText}</Popup>}
        </Circle>
        {/* Pixel-centered dot at lat/lng — default Marker anchors the tip, not the icon center */}
        <CircleMarker
          center={center}
          radius={7}
          interactive={false}
          pathOptions={{
            color: "#1d4ed8",
            fillColor: "#ffffff",
            fillOpacity: 1,
            weight: 3,
          }}
        />
      </MapContainer>
      {(heatmapLoading || heatmapError || heatmapData?.features?.length > 0) && (
        <div className="heatmap-overlay" aria-live="polite">
          {heatmapLoading && <span className="heatmap-loading">Loading tract heatmap…</span>}
          {heatmapError && <span className="heatmap-error">{heatmapError}</span>}
          {heatmapData?.features?.length > 0 && (
            <label className="heatmap-metric">
              <span>Choropleth</span>
              <select
                value={heatmapMetric}
                onChange={(e) => onHeatmapMetricChange?.(e.target.value)}
              >
                {HEATMAP_METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.key === "School" ? "School (students / sq mi in area)" : m.key}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
