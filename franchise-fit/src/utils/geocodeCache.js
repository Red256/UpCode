/**
 * In-memory LRU + single-flight dedupe for geocoder responses (reduces Nominatim/Census hits).
 */

/**
 * @param {{ maxEntries?: number }} [opts]
 */
export function createGeocodeCache(opts = {}) {
  const maxEntries = opts.maxEntries ?? 500;
  /** @type {Map<string, unknown>} */
  const map = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inflight = new Map();

  function evictIfNeeded() {
    while (map.size > maxEntries) {
      const first = map.keys().next().value;
      map.delete(first);
    }
  }

  return {
    /**
     * @param {string} key
     * @returns {unknown | undefined} undefined if missing
     */
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v);
      return v;
    },

    /**
     * @param {string} key
     * @param {unknown} value
     */
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      evictIfNeeded();
    },

    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} compute
     * @returns {Promise<T>}
     */
    getOrCompute(key, compute) {
      const hit = this.get(key);
      if (hit !== undefined) return Promise.resolve(/** @type {T} */ (hit));

      let p = inflight.get(key);
      if (!p) {
        p = (async () => {
          try {
            const v = await compute();
            this.set(key, v);
            return v;
          } finally {
            inflight.delete(key);
          }
        })();
        inflight.set(key, p);
      }
      return /** @type {Promise<T>} */ (p);
    },
  };
}

/** Stable key for forward search params (matches merged Nominatim query params). */
export function nominatimSearchCacheKey(extraParams) {
  const merged = {
    format: "json",
    limit: "8",
    addressdetails: "1",
    countrycodes: "us",
    ...extraParams,
  };
  const entries = Object.entries(merged).filter(
    ([, v]) => v != null && String(v).trim() !== "",
  );
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${String(v).trim()}`).join("&");
}

/** ~1.1 m precision — enough to reuse labels without distinct buildings colliding often. */
export function reverseCoordCacheKey(lat, lng) {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

export function freeformAddressCacheKey(address) {
  return address.trim().replace(/\s+/g, " ").toLowerCase();
}
