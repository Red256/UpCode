import { useState, useEffect, useRef, startTransition } from "react";
import { useDebounce } from "./useDebounce";
import { HttpRateLimitError, isHttpRateLimitError } from "../utils/httpErrors";
import { nominatimSearch } from "../utils/usGeocode";

/** Nominatim policy: max ~1 req/s; debounce + client cache reduce bursts. */
const NOMINATIM_DEBOUNCE_MS = 550;

const RATE_MSG =
  "Address search is rate limited. Wait a minute, then try again.";

export function useAutocomplete(query) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const debouncedQuery = useDebounce(query, NOMINATIM_DEBOUNCE_MS);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;

    if (!debouncedQuery || debouncedQuery.length < 2) {
      startTransition(() => {
        if (requestId !== requestIdRef.current) return;
        setSuggestions([]);
        setLoading(false);
        setError(null);
      });
      return;
    }

    startTransition(() => {
      if (requestId !== requestIdRef.current) return;
      setLoading(true);
      setError(null);
    });

    nominatimSearch({ q: debouncedQuery, limit: "5" })
      .then((data) => {
        if (requestId !== requestIdRef.current) return;
        const items = (Array.isArray(data) ? data : []).map((item) => {
          const parts = String(item.display_name || "").split(", ");
          return {
            primary: parts.slice(0, 2).join(", "),
            secondary: parts.slice(2).join(", "),
            fullName: item.display_name,
            lat: Number(item.lat),
            lng: Number(item.lon),
            type: item.type,
          };
        });
        setSuggestions(items);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setSuggestions([]);
        if (isHttpRateLimitError(err)) {
          setError(err instanceof HttpRateLimitError ? err.message : RATE_MSG);
        } else {
          setError(null);
        }
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });
  }, [debouncedQuery]);

  return { suggestions, loading, error };
}
