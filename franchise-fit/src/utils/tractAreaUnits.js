/**
 * Land area for census tract features (square miles).
 * Prefer Census gazetteer ALAND_SQMI (tractGeoidAreaSqMi.json): simplified map polygons often
 * underestimate geodesic area. Fallback: @turf/area on the feature geometry.
 */
import area from '@turf/area';
import tractGeoidLandSqMi from '../data/tractGeoidAreaSqMi.json';

const M2_TO_SQMI = 1 / 2589988.110336;

function geoidKey(feature) {
  const p = feature?.properties || {};
  const raw = p.geoid ?? p.GEOID ?? p.GEO_ID;
  if (raw == null) return null;
  const g = String(raw).replace(/\D/g, '').slice(0, 11);
  return g.length === 11 ? g : null;
}

export function featureAreaSqMi(feature) {
  const gid = geoidKey(feature);
  if (gid) {
    const a = tractGeoidLandSqMi[gid];
    if (typeof a === 'number' && Number.isFinite(a) && a > 0) return a;
  }
  if (!feature?.geometry) return 0;
  try {
    return area(feature) * M2_TO_SQMI;
  } catch {
    return 0;
  }
}

/** Area of a circle with radius `radiusMiles` (square miles). Used for regional student density (πr²). */
export function circleAreaSqMi(radiusMiles) {
  const r = Number(radiusMiles);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.PI * r * r;
}

export function sumFeaturesAreaSqMi(features) {
  let t = 0;
  for (const f of features) {
    t += featureAreaSqMi(f);
  }
  return t;
}
