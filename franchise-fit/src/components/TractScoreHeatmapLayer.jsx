import { useMemo, useCallback, useRef, useEffect, useState, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { GeoJSON, useMap } from "react-leaflet";
import L from "leaflet";
import centroid from "@turf/centroid";
import { colorForHeatmapScore } from "../utils/tractHeatmap";
import {
  computeOverallFromTractScores,
  scoreForChoroplethMetric,
  CHOROPLETH_METRIC_WEIGHTED,
} from "../utils/tractOverallScore";
import { featureAreaSqMi } from "../utils/tractAreaUnits";
import { formatMedianHomeValueDisplay } from "../utils/censusConstants";
import {
  analysisRingBbox,
  fetchWaterPolygonsForBounds,
  prepWaterIndex,
  lngLatInWater,
  tractShouldMaskWater,
} from "../utils/osmWater";
import { pointInPolygon, polygonBbox } from "../utils/polygon";

/** Screen-space grid for score heatmap; IDW uses every tract in the analysis disk (no subsampling). */
const GRID_COLS = 72;
const GRID_ROWS = 54;
const UPSCALE = 3;
const DEBOUNCE_MS = 200;
/** IDW power — 2 Shepard; higher = sharper near tract boundaries. */
const IDW_POWER = 2;

function projectKrigXY(lng, lat, lat0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return [lng * k, lat];
}

/** Cheap squared Euclidean distance in projected coords (avoid haversine for masking). */
function distSqProjected(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

/**
 * Inverse distance weighting on projected coords using all tract samples.
 * Returns the sole tract value when essentially coincident (stable pins).
 */
function idwScoreAt(px, py, samples, power = IDW_POWER) {
  let num = 0;
  let den = 0;
  const coincidenceSq = 1e-22;
  for (const p of samples) {
    const dx = px - p.px;
    const dy = py - p.py;
    const d2 = dx * dx + dy * dy;
    if (d2 < coincidenceSq) return p.overall;
    const d = Math.sqrt(d2);
    const w = 1 / d ** power;
    num += w * p.overall;
    den += w;
  }
  return den > 0 ? num / den : NaN;
}

/** Match choropleth: hsl(h,72%,44%) with h = 0…120 (same as colorForHeatmapScore). */
function hslToRgbBytes(h, s, l) {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) {
    rp = c;
    gp = x;
  } else {
    rp = x;
    gp = c;
  }
  return [Math.round((rp + m) * 255), Math.round((gp + m) * 255), Math.round((bp + m) * 255)];
}

function scoreToRgba(score, lo, hi) {
  const spread = Math.max(1e-6, hi - lo);
  const t = Math.max(0, Math.min(1, (score - lo) / spread));
  const hue = Math.round(120 * t);
  const [r, g, b] = hslToRgbBytes(hue, 72, 44);
  return [r, g, b, 215];
}

/** Same absolute 0–100 scale as {@link colorForHeatmapScore} (national-normalized tract scores). */
const HEATMAP_COLOR_LO = 0;
const HEATMAP_COLOR_HI = 100;

/** Darken choropleth fill + border for hover (choropleth mode only). */
function darkenChoroplethStyle(base) {
  const out = { ...base };
  const fc = out.fillColor;
  if (typeof fc === "string" && fc.startsWith("hsl(")) {
    out.fillColor = fc.replace(/,\s*(\d+(?:\.\d+)?)%\s*\)$/, (_, l) => {
      const nl = Math.max(18, Number(l) - 14);
      return `, ${nl}%)`;
    });
  } else if (typeof fc === "string" && fc.startsWith("#")) {
    out.fillColor = "#64748b";
  }
  const baseFillOp = base.fillOpacity ?? 0.34;
  const wasMuted = baseFillOp < 0.05;
  out.fillOpacity = wasMuted ? 0.26 : Math.min(0.58, baseFillOp + 0.16);
  out.color = "rgba(15,23,42,0.82)";
  out.weight = Math.max(base.weight ?? 0.75, 1.1);
  out.opacity = 1;
  return out;
}

/** Smooth score surface (IDW); masked to analysis circle, custom polygon (if any), and OSM water. */
function TractKrigingRaster({
  items,
  analysisCenterLat,
  analysisCenterLng,
  analysisRadiusMi,
  waterIndex,
  analysisPolygonLatLng,
  analysisPolygonKey,
}) {
  const map = useMap();
  const overlayRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!map) return;

    const clearOverlay = () => {
      if (overlayRef.current) {
        map.removeLayer(overlayRef.current);
        overlayRef.current = null;
      }
    };

    if (
      !items.length ||
      analysisCenterLat == null ||
      analysisCenterLng == null ||
      analysisRadiusMi == null ||
      Number.isNaN(Number(analysisRadiusMi))
    ) {
      clearOverlay();
      return;
    }

    const run = () => {
      clearOverlay();

      const bounds = map.getBounds();
      const south = bounds.getSouth();
      const north = bounds.getNorth();
      const west = bounds.getWest();
      const east = bounds.getEast();
      const lat0 = (south + north) / 2;

      const R = Math.max(1e-6, Number(analysisRadiusMi) || 0);
      const [cX, cY] = projectKrigXY(analysisCenterLng, analysisCenterLat, lat0);
      const RProj = (R * 1.08) / 69.0;
      const RSq = RProj * RProj;

      const usePoly =
        Array.isArray(analysisPolygonLatLng) && analysisPolygonLatLng.length >= 3;

      const sampleInZone = (lat, lng) => {
        if (usePoly) return pointInPolygon([lat, lng], analysisPolygonLatLng);
        const [px, py] = projectKrigXY(lng, lat, lat0);
        return distSqProjected(px, py, cX, cY) <= RSq * 1.02;
      };

      const cellInZone = (lat, lng) => {
        if (usePoly) return pointInPolygon([lat, lng], analysisPolygonLatLng);
        const [px, py] = projectKrigXY(lng, lat, lat0);
        return distSqProjected(px, py, cX, cY) <= RSq;
      };

      /** @type {{ px: number; py: number; overall: number }[]} */
      const projectedSamples = [];
      for (const p of items) {
        const v = Number(p.overall);
        if (!Number.isFinite(v)) continue;
        if (!sampleInZone(p.lat, p.lng)) continue;
        const [px, py] = projectKrigXY(p.lng, p.lat, lat0);
        projectedSamples.push({ px, py, overall: v });
      }
      if (projectedSamples.length < 3) {
        projectedSamples.length = 0;
        for (const p of items) {
          const v = Number(p.overall);
          if (!Number.isFinite(v)) continue;
          const [px, py] = projectKrigXY(p.lng, p.lat, lat0);
          projectedSamples.push({ px, py, overall: v });
        }
      }
      if (projectedSamples.length < 2) return;

      const cols = GRID_COLS;
      const rows = GRID_ROWS;
      const dLng = (east - west) / cols;
      const dLat = (north - south) / rows;

      const src = document.createElement("canvas");
      src.width = cols;
      src.height = rows;
      const sctx = src.getContext("2d");
      const img = sctx.createImageData(cols, rows);

      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const lng = west + (i + 0.5) * dLng;
          const lat = north - (j + 0.5) * dLat;
          const ix = (j * cols + i) * 4;
          if (!cellInZone(lat, lng)) {
            img.data[ix + 3] = 0;
            continue;
          }
          if (waterIndex?.length && lngLatInWater(lng, lat, waterIndex)) {
            img.data[ix + 3] = 0;
            continue;
          }
          const [px, py] = projectKrigXY(lng, lat, lat0);
          const zRaw = idwScoreAt(px, py, projectedSamples, IDW_POWER);
          if (!Number.isFinite(zRaw)) {
            img.data[ix + 3] = 0;
            continue;
          }
          const z = Math.max(0, Math.min(100, zRaw));
          const [r, g, b, a] = scoreToRgba(z, HEATMAP_COLOR_LO, HEATMAP_COLOR_HI);
          img.data[ix] = r;
          img.data[ix + 1] = g;
          img.data[ix + 2] = b;
          img.data[ix + 3] = a;
        }
      }
      sctx.putImageData(img, 0, 0);

      const out = document.createElement("canvas");
      out.width = cols * UPSCALE;
      out.height = rows * UPSCALE;
      const octx = out.getContext("2d");
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = "high";
      octx.drawImage(src, 0, 0, out.width, out.height);

      const overlay = L.imageOverlay(out.toDataURL("image/png"), [[south, west], [north, east]], {
        opacity: 0.8,
        interactive: false,
      });
      overlay.addTo(map);
      const el = overlay.getElement?.();
      if (el) {
        el.style.pointerEvents = "none";
        el.style.zIndex = "380";
      }
      overlayRef.current = overlay;
    };

    const schedule = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(run, DEBOUNCE_MS);
    };

    run();
    map.on("moveend", schedule);
    return () => {
      map.off("moveend", schedule);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (overlayRef.current) {
        map.removeLayer(overlayRef.current);
        overlayRef.current = null;
      }
    };
  }, [map, items, analysisCenterLat, analysisCenterLng, analysisRadiusMi, waterIndex, analysisPolygonKey, analysisPolygonLatLng]);

  return null;
}

export default function TractScoreHeatmapLayer({
  data,
  factors,
  onTractClick,
  analysisCenter,
  analysisRadiusMi,
  surfaceMode = "choropleth",
  choroplethMetric = CHOROPLETH_METRIC_WEIGHTED,
  disableInteraction = false,
  analysisPolygonLatLng = null,
}) {
  const map = useMap();
  const analysisCenterLat = analysisCenter?.[0];
  const analysisCenterLng = analysisCenter?.[1];

  const analysisPolygonKey = useMemo(() => {
    if (!analysisPolygonLatLng || analysisPolygonLatLng.length < 3) return "";
    return JSON.stringify(analysisPolygonLatLng);
  }, [analysisPolygonLatLng]);

  const [waterFc, setWaterFc] = useState(() => ({ type: "FeatureCollection", features: [] }));

  const onTractClickRef = useRef(onTractClick);
  const factorsRef = useRef(factors);
  const choroplethMetricRef = useRef(choroplethMetric);
  const tractChoroplethStyleRef = useRef(
    /** @type {((feature: GeoJSON.Feature) => import('leaflet').PathOptions) | null} */ (null),
  );
  const surfaceModeRef = useRef(surfaceMode);
  /** Layer currently showing choropleth hover (pan/zoom often skip mouseout). */
  const hoveredChoroplethLayerRef = useRef(/** @type {L.Path | null} */ (null));
  useEffect(() => {
    onTractClickRef.current = onTractClick;
  }, [onTractClick]);
  useEffect(() => {
    factorsRef.current = factors;
  }, [factors]);
  useEffect(() => {
    choroplethMetricRef.current = choroplethMetric;
  }, [choroplethMetric]);
  useEffect(() => {
    surfaceModeRef.current = surfaceMode;
  }, [surfaceMode]);

  useEffect(() => {
    if (!map) return;
    const clearChoroplethHover = () => {
      const layer = hoveredChoroplethLayerRef.current;
      if (!layer) return;
      const feat = layer._tractHoverFeature;
      hoveredChoroplethLayerRef.current = null;
      if (!feat) return;
      const styleFn = tractChoroplethStyleRef.current;
      if (styleFn) layer.setStyle(styleFn(feat));
    };
    map.on("movestart", clearChoroplethHover);
    map.on("zoomstart", clearChoroplethHover);
    return () => {
      map.off("movestart", clearChoroplethHover);
      map.off("zoomstart", clearChoroplethHover);
    };
  }, [map]);

  useEffect(() => {
    if (
      analysisCenterLat == null ||
      analysisCenterLng == null ||
      analysisRadiusMi == null ||
      Number.isNaN(Number(analysisRadiusMi))
    ) {
      queueMicrotask(() => {
        setWaterFc({ type: "FeatureCollection", features: [] });
      });
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      setWaterFc({ type: "FeatureCollection", features: [] });
    });

    let south;
    let west;
    let north;
    let east;
    if (analysisPolygonLatLng?.length >= 3) {
      const bb = polygonBbox(analysisPolygonLatLng);
      const padDeg = 0.04;
      south = bb.minLat - padDeg;
      north = bb.maxLat + padDeg;
      west = bb.minLng - padDeg;
      east = bb.maxLng + padDeg;
    } else {
      const ring = analysisRingBbox(analysisCenterLat, analysisCenterLng, Number(analysisRadiusMi));
      south = ring.south;
      west = ring.west;
      north = ring.north;
      east = ring.east;
    }

    fetchWaterPolygonsForBounds(south, west, north, east)
      .then((fc) => {
        if (!cancelled) {
          setWaterFc(fc ?? { type: "FeatureCollection", features: [] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWaterFc({ type: "FeatureCollection", features: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [analysisCenterLat, analysisCenterLng, analysisRadiusMi, analysisPolygonKey, analysisPolygonLatLng]);

  const waterIndex = useMemo(() => prepWaterIndex(waterFc), [waterFc]);

  /** Census tract polygons — score fill (choropleth) + click / popup on the polygon. Water tracts omitted once OSM index loads. */
  const choroplethData = useMemo(() => {
    if (!data?.features?.length) return null;
    let features = data.features.filter(
      (f) =>
        f.geometry &&
        (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"),
    );
    if (waterIndex.length > 0) {
      features = features.filter((f) => !tractShouldMaskWater(f, waterIndex));
    }
    if (!features.length) return null;
    return { type: "FeatureCollection", features };
  }, [data, waterIndex]);

  const tractChoroplethStyle = useCallback(
    (feature) => {
      if (surfaceMode === "kriging") {
        return {
          fillColor: "#0f172a",
          fillOpacity: 0.001,
          color: "rgba(30,41,59,0)",
          weight: 0,
          opacity: 1,
        };
      }
      const mapScore = scoreForChoroplethMetric(choroplethMetric, factors, feature.properties.scores);

      const isLoadingScores = mapScore == null || Number.isNaN(mapScore);

      if (isLoadingScores) {
        return {
          fillColor: "#94a3b8",
          fillOpacity: 0.25,
          color: "rgba(100,116,139,0.4)",
          weight: 0.5,
          opacity: 0.7,
        };
      }

      return {
        fillColor: colorForHeatmapScore(mapScore),
        fillOpacity: 0.34,
        color: "rgba(30,41,59,0.55)",
        weight: 0.75,
        opacity: 0.9,
      };
    },
    [factors, surfaceMode, choroplethMetric],
  );

  useEffect(() => {
    tractChoroplethStyleRef.current = tractChoroplethStyle;
  }, [tractChoroplethStyle]);

  /** Entering free-draw: clear stuck choropleth hover (listeners may have been removed). */
  useEffect(() => {
    if (!disableInteraction) return;
    const layer = hoveredChoroplethLayerRef.current;
    const feat = layer?._tractHoverFeature;
    const fn = tractChoroplethStyleRef.current;
    if (layer && feat && fn) {
      try {
        layer.setStyle(fn(feat));
      } catch {
        /* ignore */
      }
    }
    hoveredChoroplethLayerRef.current = null;
  }, [disableInteraction]);

  const items = useMemo(() => {
    if (!data?.features?.length) return [];
    const out = [];
    for (const f of data.features) {
      if (!f.geometry) continue;
      if (waterIndex.length > 0 && tractShouldMaskWater(f, waterIndex)) continue;
      try {
        const pre = f.properties.centroid;
        let lat;
        let lng;
        if (pre?.lat != null && pre?.lng != null) {
          lat = pre.lat;
          lng = pre.lng;
        } else {
          const c = centroid(f);
          [lng, lat] = c.geometry.coordinates;
        }
        const mapScore = scoreForChoroplethMetric(choroplethMetric, factors, f.properties.scores);
        out.push({ feature: f, lat, lng, overall: mapScore });
      } catch {
        /* skip invalid geom */
      }
    }
    return out;
  }, [data, factors, choroplethMetric, waterIndex]);

  const renderPopupBody = useCallback((feature, weightedOverall, mapMetric, mapScore) => {
    const r = feature.properties.raw || {};
    const name = r.name || feature.properties.NAME || feature.properties.name || "—";
    const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
    const fmtMoney = (n) => (n == null ? "—" : `$${fmt(n)}`);
    const sqMi = featureAreaSqMi(feature);
    const stud =
      r.studentPopulation != null &&
      !Number.isNaN(r.studentPopulation) &&
      sqMi > 0
        ? `${(r.studentPopulation / sqMi).toLocaleString("en-US", {
            maximumFractionDigits: 1,
            minimumFractionDigits: 0,
          })} students/sq mi`
        : "—";
    const mapLabel =
      mapMetric === CHOROPLETH_METRIC_WEIGHTED ? "Weighted score (map)" : `${mapMetric} (map)`;
    return (
      <div style={{ fontSize: 12, minWidth: 360, maxWidth: 480, fontFamily: "system-ui, sans-serif" }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{name}</div>
        <div>
          {mapLabel}: <strong>{mapScore != null ? mapScore : "—"}</strong>
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
          Weighted (panel): <strong>{weightedOverall != null ? weightedOverall : "—"}</strong>
        </div>
        <div>Median income: {fmtMoney(r.income)}</div>
        <div>Median gross rent: {fmtMoney(r.rent)}</div>
        <div>Median home value: {formatMedianHomeValueDisplay(r.homeValue)}</div>
        <div>Students per sq mi (ACS): {stud}</div>
        <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
          Click for trends &amp; projections
        </div>
      </div>
    );
  }, []);

  const onEachTractFeature = useCallback(
    (feature, layer) => {
      layer._tractHoverFeature = feature;

      const wrap = document.createElement("div");
      layer.bindPopup(wrap, { maxWidth: 520, minWidth: 340, className: "tract-leaflet-popup" });
      layer.on("popupopen", () => {
        let root = layer._tractPopupRoot;
        if (!root) {
          root = createRoot(wrap);
          layer._tractPopupRoot = root;
        }
        const weightedOverall = computeOverallFromTractScores(
          factorsRef.current,
          feature.properties.scores,
        );
        const metric = choroplethMetricRef.current;
        const mapScore = scoreForChoroplethMetric(metric, factorsRef.current, feature.properties.scores);
        root.render(renderPopupBody(feature, weightedOverall, metric, mapScore));
      });
      layer.on("click", () => {
        onTractClickRef.current?.(feature);
      });
      layer.on("mouseover", () => {
        if (surfaceModeRef.current !== "choropleth") return;
        const styleFn = tractChoroplethStyleRef.current;
        if (!styleFn) return;
        const prev = hoveredChoroplethLayerRef.current;
        if (prev && prev !== layer && prev._tractHoverFeature) {
          const fn = tractChoroplethStyleRef.current;
          if (fn) prev.setStyle(fn(prev._tractHoverFeature));
        }
        const base = styleFn(feature);
        layer.setStyle(darkenChoroplethStyle(base));
        if (typeof layer.bringToFront === "function") layer.bringToFront();
        hoveredChoroplethLayerRef.current = layer;
      });
      layer.on("mouseout", () => {
        if (surfaceModeRef.current !== "choropleth") return;
        const styleFn = tractChoroplethStyleRef.current;
        if (!styleFn) return;
        layer.setStyle(styleFn(feature));
        if (hoveredChoroplethLayerRef.current === layer) hoveredChoroplethLayerRef.current = null;
      });
      layer.on("remove", () => {
        if (hoveredChoroplethLayerRef.current === layer) hoveredChoroplethLayerRef.current = null;
        const root = layer._tractPopupRoot;
        if (root) {
          root.unmount();
          layer._tractPopupRoot = undefined;
        }
      });
    },
    [renderPopupBody],
  );

  if (!items.length) return null;

  return (
    <Fragment>
      {choroplethData && (
        <GeoJSON
          key={`tract-choro-${disableInteraction ? "no-pointer" : "pointer"}-${data?.partial ? "partial" : "full"}-${data?.loadGen || 0}`}
          data={choroplethData}
          style={tractChoroplethStyle}
          interactive={!disableInteraction}
          onEachFeature={disableInteraction ? undefined : onEachTractFeature}
        />
      )}
      {surfaceMode === "kriging" && (
        <TractKrigingRaster
          items={items}
          analysisCenterLat={analysisCenterLat}
          analysisCenterLng={analysisCenterLng}
          analysisRadiusMi={analysisRadiusMi}
          waterIndex={waterIndex}
          analysisPolygonLatLng={analysisPolygonLatLng}
          analysisPolygonKey={analysisPolygonKey}
        />
      )}
    </Fragment>
  );
}
