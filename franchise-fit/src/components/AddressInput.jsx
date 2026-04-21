import { useState, useRef, useEffect, startTransition } from "react";
import { useAutocomplete } from "../hooks/useAutocomplete";

export default function AddressInput({ value, onChange, onSelect }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { suggestions, loading } = useAutocomplete(value);
  const wrapRef = useRef(null);

  const showDropdown = open && (suggestions.length > 0 || loading);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    startTransition(() => setActiveIndex(-1));
  }, [suggestions]);

  function handleKeyDown(e) {
    if (!showDropdown) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      pickSuggestion(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function pickSuggestion(item) {
    onChange(item.fullName);
    onSelect(item);
    setOpen(false);
  }

  return (
    <div className="location-input-wrap" ref={wrapRef}>
      <input
        placeholder="Search city or street address"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />

      {showDropdown && (
        <div className="autocomplete-dropdown">
          {loading && suggestions.length === 0 && (
            <div className="autocomplete-loading">Searching...</div>
          )}
          {suggestions.map((item, i) => (
            <div
              key={`${item.lat}-${item.lng}-${i}`}
              className={`autocomplete-item ${i === activeIndex ? "active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={() => pickSuggestion(item)}
            >
              <div className="ac-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              </div>
              <div className="ac-text">
                <div className="ac-primary">{item.primary}</div>
                {item.secondary && (
                  <div className="ac-secondary">{item.secondary}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
