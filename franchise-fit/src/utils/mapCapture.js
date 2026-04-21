import html2canvas from 'html2canvas';
import { BEFORE_MAP_CAPTURE, MAP_CAPTURE_ROOT_ID } from './mapConstants';

function loadImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Rasterize the live Leaflet map (marker + radius circle) for the PDF.
 * Returns intrinsic pixel size so the PDF can preserve aspect ratio (no vertical squash).
 * Requires OSM tiles with crossOrigin so the canvas is not tainted.
 */
export async function captureMapToDataUrl(center, zoom) {
  const el = document.getElementById(MAP_CAPTURE_ROOT_ID);
  if (!el) return null;

  window.dispatchEvent(new Event('resize'));
  document.dispatchEvent(new Event(BEFORE_MAP_CAPTURE));
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  try {
    const canvas = await html2canvas(el, {
      useCORS: true,
      allowTaint: false,
      scale: Math.min(2, window.devicePixelRatio || 2),
      logging: false,
      backgroundColor: '#e5e7eb',
      ignoreElements: (node) =>
        node.classList?.contains?.('leaflet-control-container') === true,
    });
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl && dataUrl.length > 500) {
      return {
        dataUrl,
        width: canvas.width,
        height: canvas.height,
      };
    }
  } catch (e) {
    console.warn('Map snapshot failed:', e);
  }

  return tryStaticMapFallback(center, zoom);
}

/**
 * Fallback to static map (requires internet).
 * In offline mode, this will gracefully return null.
 */
async function tryStaticMapFallback(center, zoom) {
  // Skip static map in offline mode
  if (!navigator.onLine) {
    console.info('Offline: skipping static map fallback');
    return null;
  }
  
  const lat = Number(center[0]);
  const lon = Number(center[1]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  const z = Math.min(18, Math.max(1, Math.round(Number(zoom) || 12)));
  const url = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=${z}&size=800x400&maptype=mapnik&markers=${lat},${lon},lightblue1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const dims = await loadImageDimensions(dataUrl);
    return { dataUrl, width: dims.width, height: dims.height };
  } catch {
    return null;
  }
}
