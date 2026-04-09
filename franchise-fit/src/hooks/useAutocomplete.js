import { useState, useEffect, useRef, startTransition } from "react";
import { useDebounce } from "./useDebounce";

export function useAutocomplete(query) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 300);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < 2) {
      startTransition(() => {
        setSuggestions([]);
        setLoading(false);
      });
      return;
    }

    startTransition(() => setLoading(true));

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&countrycodes=us&q=" +
      encodeURIComponent(debouncedQuery);

    fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((res) => res.json())
      .then((data) => {
        const items = (data || []).map((item) => {
          const parts = item.display_name.split(", ");
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
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setSuggestions([]);
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [debouncedQuery]);

  return { suggestions, loading };
}
