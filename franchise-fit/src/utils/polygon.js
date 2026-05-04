// =====================================================================
// Polygon utilities — shape constructors, math, clipping, grid sampling
//
// Coordinates are stored as [lat, lng] arrays (Leaflet convention).
// All shape constructors take a center [lat, lng] and a "size" in miles
// (radius for circle/polygons, half-side for square) and return a
// vertex array. The result is editable — vertices can be moved freely.
// =====================================================================

const MILES_PER_LAT_DEG = 69.0;

function lngDegPerMile(lat) {
  return 1 / (MILES_PER_LAT_DEG * Math.cos((lat * Math.PI) / 180));
}

function latDegPerMile() {
  return 1 / MILES_PER_LAT_DEG;
}

// ---- Shape constructors ----

export function makeCirclePolygon(center, radiusMi, vertices = 32) {
  const [lat, lng] = center;
  const dLat = latDegPerMile();
  const dLng = lngDegPerMile(lat);
  const points = [];
  for (let i = 0; i < vertices; i++) {
    const theta = (i / vertices) * 2 * Math.PI - Math.PI / 2; // start at top
    points.push([
      lat + radiusMi * dLat * Math.sin(theta),
      lng + radiusMi * dLng * Math.cos(theta),
    ]);
  }
  return points;
}

export function makeSquarePolygon(center, halfSideMi) {
  const [lat, lng] = center;
  const dLat = latDegPerMile();
  const dLng = lngDegPerMile(lat);
  const h = halfSideMi;
  return [
    [lat + h * dLat, lng - h * dLng],
    [lat + h * dLat, lng + h * dLng],
    [lat - h * dLat, lng + h * dLng],
    [lat - h * dLat, lng - h * dLng],
  ];
}

export function makeTrianglePolygon(center, radiusMi) {
  return regularNgon(center, radiusMi, 3, -Math.PI / 2);
}

export function makePentagonPolygon(center, radiusMi) {
  return regularNgon(center, radiusMi, 5, -Math.PI / 2);
}

export function makeHexagonPolygon(center, radiusMi) {
  return regularNgon(center, radiusMi, 6, -Math.PI / 2);
}

function regularNgon(center, radiusMi, sides, rotation = 0) {
  const [lat, lng] = center;
  const dLat = latDegPerMile();
  const dLng = lngDegPerMile(lat);
  const points = [];
  for (let i = 0; i < sides; i++) {
    const theta = (i / sides) * 2 * Math.PI + rotation;
    points.push([
      lat + radiusMi * dLat * Math.sin(theta),
      lng + radiusMi * dLng * Math.cos(theta),
    ]);
  }
  return points;
}

// ---- Bounding box ----

export function polygonBbox(polygon) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of polygon) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

// ---- Centroid (area-weighted, planar approximation) ----

export function polygonCentroid(polygon) {
  let cx = 0, cy = 0, area = 0;
  for (let i = 0, n = polygon.length; i < n; i++) {
    const [y0, x0] = polygon[i];
    const [y1, x1] = polygon[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-12) {
    // Degenerate; fall back to simple mean
    const meanLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
    const meanLng = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
    return [meanLat, meanLng];
  }
  return [cy / (6 * area), cx / (6 * area)];
}

// ---- Point-in-polygon (ray casting) ----

export function pointInPolygon(point, polygon) {
  const [lat, lng] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [iLat, iLng] = polygon[i];
    const [jLat, jLng] = polygon[j];
    const intersect =
      iLng > lng !== jLng > lng &&
      lat < ((jLat - iLat) * (lng - iLng)) / (jLng - iLng) + iLat;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---- Polygon area in square miles (planar approximation) ----

export function polygonAreaSqMi(polygon) {
  if (polygon.length < 3) return 0;
  const centerLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const milesPerLat = MILES_PER_LAT_DEG;
  const milesPerLng = MILES_PER_LAT_DEG * Math.cos((centerLat * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [y0, x0] = polygon[i];
    const [y1, x1] = polygon[(i + 1) % polygon.length];
    const xMi0 = x0 * milesPerLng;
    const yMi0 = y0 * milesPerLat;
    const xMi1 = x1 * milesPerLng;
    const yMi1 = y1 * milesPerLat;
    area += xMi0 * yMi1 - xMi1 * yMi0;
  }
  return Math.abs(area) * 0.5;
}

// ---- Effective radius (radius of a circle with the same area) ----

export function polygonEffectiveRadiusMi(polygon) {
  const area = polygonAreaSqMi(polygon);
  return Math.sqrt(area / Math.PI);
}

// ---- Grid generation, clipped to polygon ----

export function generateGridPointsInPolygon(polygon, options = {}) {
  if (polygon.length < 3) {
    return { points: [], cellLatHalf: 0, cellLngHalf: 0, gridSize: 0 };
  }

  const opts = typeof options === "number"
    ? { gridSize: options }
    : options;
  const {
    targetInteriorCells = 1500,
    minGridSize = 30,
    maxGridSize = 100,
    gridSize: forcedGridSize = null,
  } = opts;

  const { minLat, maxLat, minLng, maxLng } = polygonBbox(polygon);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;

  let gridSize;
  if (forcedGridSize) {
    gridSize = forcedGridSize;
  } else {
    const polyArea = polygonAreaSqMi(polygon);
    const centerLat = (minLat + maxLat) / 2;
    const milesPerLat = MILES_PER_LAT_DEG;
    const milesPerLng = MILES_PER_LAT_DEG * Math.cos((centerLat * Math.PI) / 180);
    const bboxAreaSqMi = (latSpan * milesPerLat) * (lngSpan * milesPerLng);
    const fillRatio = bboxAreaSqMi > 0 ? polyArea / bboxAreaSqMi : 1;
    const totalCellsNeeded = targetInteriorCells / Math.max(0.05, fillRatio);
    gridSize = Math.ceil(Math.sqrt(totalCellsNeeded));
    gridSize = Math.max(minGridSize, Math.min(maxGridSize, gridSize));
  }

  const points = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const lat = minLat + (latSpan * row) / (gridSize - 1);
      const lng = minLng + (lngSpan * col) / (gridSize - 1);
      if (pointInPolygon([lat, lng], polygon)) {
        points.push({
          lat: parseFloat(lat.toFixed(6)),
          lon: parseFloat(lng.toFixed(6)),
          row,
          col,
        });
      }
    }
  }
  const cellLatHalf = latSpan / (gridSize - 1) / 2;
  const cellLngHalf = lngSpan / (gridSize - 1) / 2;
  return { points, cellLatHalf, cellLngHalf, gridSize };
}

// ---- Vertex helpers ----

export function moveVertex(polygon, index, newLatLng) {
  return polygon.map((p, i) => (i === index ? [newLatLng[0], newLatLng[1]] : p));
}

export function insertVertex(polygon, index, latLng) {
  const next = [...polygon];
  next.splice(index + 1, 0, [latLng[0], latLng[1]]);
  return next;
}

export function removeVertex(polygon, index) {
  if (polygon.length <= 3) return polygon;
  const next = [...polygon];
  next.splice(index, 1);
  return next;
}

export function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
