import { useEffect, useState } from "react";

export default function Toast({ message, subMessage, visible, onClose, duration = 4000 }) {
  const [render, setRender] = useState(visible);

  useEffect(() => {
    if (!visible) return;
    const showT = setTimeout(() => setRender(true), 0);
    const closeT = setTimeout(() => onClose?.(), duration);
    return () => {
      clearTimeout(showT);
      clearTimeout(closeT);
    };
  }, [visible, duration, onClose]);

  useEffect(() => {
    if (visible) return;
    if (!render) return;
    const hideT = setTimeout(() => setRender(false), 250);
    return () => clearTimeout(hideT);
  }, [visible, render]);

  if (!render) return null;

  return (
    <div className={`toast ${visible ? "toast-in" : "toast-out"}`} role="status" aria-live="polite">
      <div className="toast-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <div className="toast-body">
        <div className="toast-title">{message}</div>
        {subMessage && <div className="toast-sub">{subMessage}</div>}
      </div>
      <button className="toast-close" onClick={onClose} aria-label="Dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
