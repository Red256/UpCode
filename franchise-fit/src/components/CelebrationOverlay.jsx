import { useEffect, useRef } from "react";

const COLORS = [
  "#22c55e",
  "#eab308",
  "#3b82f6",
  "#ec4899",
  "#a855f7",
  "#06b6d4",
  "#f97316",
  "#ffffff",
];

function resizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * Full-screen confetti burst (canvas). Fires when `burstKey` increments.
 */
export default function CelebrationOverlay({ burstKey }) {
  const ref = useRef(null);
  const lastKey = useRef(0);

  useEffect(() => {
    if (!burstKey || burstKey === lastKey.current) return;
    lastKey.current = burstKey;
    const canvas = ref.current;
    if (!canvas) return;

    const { ctx, w, h } = resizeCanvas(canvas);
    const particles = [];
    const n = 180;
    for (let i = 0; i < n; i++) {
      particles.push({
        x: Math.random() * w,
        y: -30 - Math.random() * h * 0.4,
        vx: (Math.random() - 0.5) * 4,
        vy: 1.5 + Math.random() * 6,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.25,
        w: 5 + Math.random() * 9,
        h: 3 + Math.random() * 7,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        shape: Math.random() > 0.45 ? "rect" : "oval",
        drag: 0.985 + Math.random() * 0.01,
      });
    }

    const start = performance.now();
    const duration = 4800;
    let rafId = null;

    const tick = (now) => {
      const t = now - start;
      ctx.clearRect(0, 0, w, h);
      const fade = t > duration * 0.72 ? Math.max(0, 1 - (t - duration * 0.72) / (duration * 0.28)) : 1;

      for (const p of particles) {
        p.vx *= p.drag;
        p.x += p.vx + Math.sin(t * 0.002 + p.rot) * 0.4;
        p.y += p.vy;
        p.vy += 0.11;
        p.rot += p.vr;

        if (p.y > h + 40) {
          p.y = -20 - Math.random() * 80;
          p.x = Math.random() * w;
          p.vy = 2 + Math.random() * 4;
        }

        ctx.save();
        ctx.globalAlpha = fade * (0.75 + Math.sin(p.rot * 2) * 0.15);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === "rect") {
          ctx.fillRect(-p.w * 0.5, -p.h * 0.5, p.w, p.h);
        } else {
          ctx.beginPath();
          ctx.ellipse(0, 0, p.w * 0.5, p.h * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (t < duration) {
        rafId = requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, w, h);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [burstKey]);

  return (
    <canvas
      ref={ref}
      className="celebration-canvas"
      aria-hidden="true"
    />
  );
}
