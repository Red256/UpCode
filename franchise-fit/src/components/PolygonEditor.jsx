import { useEffect, useMemo, useLayoutEffect } from "react";
import { Polygon, Marker, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import {
  insertVertex,
  removeVertex,
  moveVertex,
  midpoint,
  makeCirclePolygon,
  makeSquarePolygon,
  makeTrianglePolygon,
  makePentagonPolygon,
  makeHexagonPolygon,
} from "../utils/polygon";

const SHAPE_BUILDERS = {
  circle: (center, sizeMi) => makeCirclePolygon(center, sizeMi, 32),
  square: (center, sizeMi) => makeSquarePolygon(center, sizeMi),
  triangle: (center, sizeMi) => makeTrianglePolygon(center, sizeMi),
  pentagon: (center, sizeMi) => makePentagonPolygon(center, sizeMi),
  hexagon: (center, sizeMi) => makeHexagonPolygon(center, sizeMi),
};

const POLYGON_STYLE = {
  color: "#2563eb",
  weight: 2.5,
  fillColor: "#2563eb",
  fillOpacity: 0.06,
  dashArray: undefined,
};

const DRAW_STYLE = {
  color: "#2563eb",
  weight: 2,
  dashArray: "6 6",
};

/** Above default marker pane (600), below tooltips (650) — reliable clicks over choropleth SVG */
const POLYGON_HANDLES_PANE = "polygonHandles";

const VERTEX_ICON = L.divIcon({
  html: `<div style="
    width:28px;height:28px;display:flex;align-items:center;justify-content:center;
    pointer-events:auto;
  "><div style="
    width:14px;height:14px;border-radius:50%;
    background:#fff;border:2.5px solid #2563eb;
    box-shadow:0 1px 4px rgba(0,0,0,0.18);
    cursor:grab;
    pointer-events:auto;
  "></div></div>`,
  className: "polygon-vertex",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const MIDPOINT_ICON = L.divIcon({
  html: `<div style="
    width:28px;height:28px;display:flex;align-items:center;justify-content:center;
    pointer-events:auto;
  "><div style="
    width:10px;height:10px;border-radius:50%;
    background:rgba(37,99,235,0.45);
    border:1.5px solid #fff;
    box-shadow:0 1px 3px rgba(0,0,0,0.15);
    cursor:copy;
    pointer-events:auto;
  "></div></div>`,
  className: "polygon-midpoint",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

function DrawHandler({ active, onAddPoint, onFinish }) {
  useMapEvents({
    click: (e) => {
      if (!active) return;
      onAddPoint([e.latlng.lat, e.latlng.lng]);
    },
    dblclick: (e) => {
      if (!active) return;
      L.DomEvent.stop(e.originalEvent);
      onFinish();
    },
    keydown: (e) => {
      if (!active) return;
      if (e.originalEvent.key === "Enter") onFinish();
    },
  });
  return null;
}

export default function PolygonEditor({
  polygon,
  drawingMode,
  draftPolygon,
  onPolygonChange,
  onDraftChange,
  onExitDrawing,
}) {
  const isDrawing = drawingMode === "building";

  const map = useMap();

  useLayoutEffect(() => {
    if (!map.getPane(POLYGON_HANDLES_PANE)) {
      const pane = map.createPane(POLYGON_HANDLES_PANE);
      pane.style.zIndex = "660";
      pane.style.pointerEvents = "auto";
    }
  }, [map]);

  useEffect(() => {
    if (!map) return;
    if (isDrawing) {
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
    }
  }, [map, isDrawing]);

  const midpoints = useMemo(() => {
    if (!polygon || polygon.length < 2 || isDrawing) return [];
    return polygon.map((p, i) => {
      const next = polygon[(i + 1) % polygon.length];
      return { latLng: midpoint(p, next), index: i };
    });
  }, [polygon, isDrawing]);

  return (
    <>
      <DrawHandler
        active={isDrawing}
        onAddPoint={(pt) => onDraftChange([...(draftPolygon || []), pt])}
        onFinish={() => {
          if ((draftPolygon || []).length >= 3) {
            onPolygonChange(draftPolygon);
          }
          onExitDrawing();
        }}
      />

      {!isDrawing && polygon && polygon.length >= 3 && (
        <Polygon positions={polygon} pathOptions={POLYGON_STYLE} interactive={false} />
      )}

      {!isDrawing &&
        polygon &&
        polygon.map((vertex, i) => (
          <Marker
            key={`v-${i}`}
            position={vertex}
            pane={POLYGON_HANDLES_PANE}
            zIndexOffset={800}
            icon={VERTEX_ICON}
            draggable
            eventHandlers={{
              drag: (e) => {
                const next = e.target.getLatLng();
                onPolygonChange(moveVertex(polygon, i, [next.lat, next.lng]));
              },
              click: (e) => {
                const orig = e.originalEvent;
                if (orig.altKey || orig.shiftKey) {
                  L.DomEvent.stop(orig);
                  onPolygonChange(removeVertex(polygon, i));
                }
              },
            }}
          />
        ))}

      {!isDrawing &&
        midpoints.map(({ latLng, index }) => (
          <Marker
            key={`mid-${index}`}
            position={latLng}
            pane={POLYGON_HANDLES_PANE}
            zIndexOffset={900}
            icon={MIDPOINT_ICON}
            interactive
            eventHandlers={{
              mousedown: (e) => {
                L.DomEvent.stop(e.originalEvent);
              },
              touchstart: (e) => {
                L.DomEvent.stop(e.originalEvent);
              },
              click: (e) => {
                L.DomEvent.stop(e.originalEvent);
                onPolygonChange(insertVertex(polygon, index, latLng));
              },
            }}
          />
        ))}

      {isDrawing && draftPolygon && draftPolygon.length > 0 && (
        <>
          {draftPolygon.length === 1 && (
            <Marker position={draftPolygon[0]} icon={VERTEX_ICON} interactive={false} />
          )}
          {draftPolygon.length >= 2 && (
            <Polyline
              positions={
                draftPolygon.length >= 3
                  ? [...draftPolygon, draftPolygon[0]]
                  : draftPolygon
              }
              pathOptions={DRAW_STYLE}
            />
          )}
          {draftPolygon.map((v, i) => (
            <Marker
              key={`draft-v-${i}`}
              position={v}
              icon={VERTEX_ICON}
              interactive={false}
            />
          ))}
        </>
      )}
    </>
  );
}

export function ShapeToolbar({
  center,
  presetSizeMi,
  onSelectShape,
  onStartFreeDraw,
  drawingMode,
  draftCount,
  onCancelDrawing,
  onFinishDrawing,
  onClear,
}) {
  const isDrawing = drawingMode === "building";
  return (
    <div className="shape-toolbar">
      <div className="shape-toolbar-label">Area shape</div>
      <div className="shape-toolbar-row">
        <ShapeButton
          title="Circle"
          icon="circle"
          onClick={() => onSelectShape(SHAPE_BUILDERS.circle(center, presetSizeMi))}
        />
        <ShapeButton
          title="Square"
          icon="square"
          onClick={() => onSelectShape(SHAPE_BUILDERS.square(center, presetSizeMi))}
        />
        <ShapeButton
          title="Triangle"
          icon="triangle"
          onClick={() => onSelectShape(SHAPE_BUILDERS.triangle(center, presetSizeMi))}
        />
        <ShapeButton
          title="Pentagon"
          icon="pentagon"
          onClick={() => onSelectShape(SHAPE_BUILDERS.pentagon(center, presetSizeMi))}
        />
        <ShapeButton
          title="Hexagon"
          icon="hexagon"
          onClick={() => onSelectShape(SHAPE_BUILDERS.hexagon(center, presetSizeMi))}
        />
        <ShapeButton
          title={isDrawing ? "Drawing — click map to add, double-click to finish" : "Free draw"}
          icon="pencil"
          active={isDrawing}
          onClick={isDrawing ? onCancelDrawing : onStartFreeDraw}
        />
      </div>
      {isDrawing && (
        <div className="shape-toolbar-draw-hint">
          <span>Click the map to add points · double-click or press Enter to finish · {draftCount} point{draftCount === 1 ? "" : "s"}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {draftCount >= 3 && (
              <button className="shape-toolbar-mini" onClick={onFinishDrawing}>Finish</button>
            )}
            <button className="shape-toolbar-mini" onClick={onCancelDrawing}>Cancel</button>
          </div>
        </div>
      )}
      {!isDrawing && (
        <div className="shape-toolbar-hint">
          Drag vertices to reshape · click midpoints to add · alt-click to delete
          {onClear && (
            <button className="shape-toolbar-mini-link" onClick={onClear}>
              Reset to circle
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ShapeButton({ title, icon, onClick, active }) {
  return (
    <button
      className={`shape-btn${active ? " shape-btn--active" : ""}`}
      onClick={onClick}
      title={title}
      type="button"
    >
      <ShapeIcon name={icon} />
    </button>
  );
}

function ShapeIcon({ name }) {
  switch (name) {
    case "circle":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "square":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "triangle":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 2 L14 13 L2 13 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case "pentagon":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 2 L14 6.6 L11.7 13.5 L4.3 13.5 L2 6.6 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case "hexagon":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M5 2 L11 2 L14 8 L11 14 L5 14 L2 8 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case "pencil":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M11 2 L14 5 L5 14 L2 14 L2 11 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
          <path d="M9 4 L12 7" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    default:
      return null;
  }
}
