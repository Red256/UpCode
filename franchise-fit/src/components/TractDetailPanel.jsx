import { useState, useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';
import { fetchTractHistory, projectFuture } from '../utils/censusApi';

const METRICS = [
  { key: 'income', label: 'Median Income', format: (v) => (v ? `$${Math.round(v).toLocaleString()}` : '—'), color: '#2563eb' },
  { key: 'rent', label: 'Median Rent', format: (v) => (v ? `$${Math.round(v).toLocaleString()}` : '—'), color: '#16a34a' },
  { key: 'homeValue', label: 'Home Value', format: (v) => (v ? `$${Math.round(v).toLocaleString()}` : '—'), color: '#a855f7' },
  { key: 'education', label: 'Education (BA+)', format: (v) => (v ? `${v.toFixed(1)}%` : '—'), color: '#f59e0b' },
];

export default function TractDetailPanel({ tract, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [projections, setProjections] = useState([]);
  const [activeMetric, setActiveMetric] = useState('income');
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => {
    if (!tract?.properties?.geoid) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const hist = await fetchTractHistory(tract.properties.geoid);
        if (cancelled) return;

        if (!hist.length) {
          setError('No historical data available for this tract.');
          setHistory([]);
          setProjections([]);
        } else {
          setHistory(hist);
          const proj = projectFuture(hist, 3);
          setProjections(proj);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Failed to load tract history.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tract?.properties?.geoid]);

  useEffect(() => {
    if (!chartRef.current || !history.length) return;

    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    const allData = [...history, ...projections];
    const metric = METRICS.find((m) => m.key === activeMetric);
    const labels = allData.map((d) => d.year);
    const values = allData.map((d) => d[activeMetric]);
    const isProjected = allData.map((d) => d.projected);

    chartInstance.current = new Chart(chartRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: metric?.label || activeMetric,
            data: values,
            borderColor: metric?.color || '#2563eb',
            backgroundColor: `${metric?.color || '#2563eb'}20`,
            fill: true,
            tension: 0.3,
            pointRadius: values.map((_, i) => (isProjected[i] ? 6 : 4)),
            pointStyle: values.map((_, i) => (isProjected[i] ? 'triangle' : 'circle')),
            segment: {
              borderDash: (ctx) => (isProjected[ctx.p1DataIndex] ? [5, 5] : []),
            },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                const formatted = metric?.format(v) || v;
                const suffix = isProjected[ctx.dataIndex] ? ' (projected)' : '';
                return `${formatted}${suffix}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 11 } },
          },
          y: {
            beginAtZero: false,
            ticks: {
              font: { size: 11 },
              callback: (v) => {
                if (activeMetric === 'education') return `${v}%`;
                if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
                if (v >= 1000) return `$${(v / 1000).toFixed(0)}K`;
                return `$${v}`;
              },
            },
          },
        },
      },
    });

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [history, projections, activeMetric]);

  if (!tract) return null;

  const raw = tract.properties?.raw || {};
  const name = raw.name || tract.properties?.NAME || 'Census Tract';

  const latestProj = projections[projections.length - 1];

  const getTrend = (key) => {
    if (history.length < 2) return null;
    const first = history.find((h) => h[key] != null);
    const last = [...history].reverse().find((h) => h[key] != null);
    if (!first || !last || first === last) return null;
    const change = ((last[key] - first[key]) / first[key]) * 100;
    return change;
  };

  return (
    <div className="tract-detail-panel">
      <div className="tract-detail-header">
        <div>
          <h3>{name}</h3>
          <span className="tract-geoid">GEOID: {tract.properties?.geoid}</span>
        </div>
        <button className="tract-close-btn" onClick={onClose} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="tract-current-metrics">
        <div className="tract-metric-grid">
          {METRICS.map((m) => {
            const val = m.key === 'education' ? raw.schoolProxy : raw[m.key];
            const trend = getTrend(m.key);
            return (
              <div
                key={m.key}
                className={`tract-metric-card ${activeMetric === m.key ? 'active' : ''}`}
                onClick={() => setActiveMetric(m.key)}
              >
                <div className="tract-metric-label">{m.label}</div>
                <div className="tract-metric-value" style={{ color: m.color }}>
                  {m.format(val)}
                </div>
                {trend != null && (
                  <div className={`tract-metric-trend ${trend >= 0 ? 'up' : 'down'}`}>
                    {trend >= 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}% over 5yr
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="tract-chart-section">
        <div className="tract-chart-header">
          <h4>Historical Trend & Projection</h4>
          <div className="tract-chart-legend">
            <span className="legend-historical">● Historical</span>
            <span className="legend-projected">▲ Projected</span>
          </div>
        </div>
        {loading && <div className="tract-loading">Loading historical data...</div>}
        {error && <div className="tract-error">{error}</div>}
        {!loading && !error && history.length > 0 && (
          <div className="tract-chart-container">
            <canvas ref={chartRef} />
          </div>
        )}
      </div>

      {latestProj && (
        <div className="tract-projections">
          <h4>Projected Values ({latestProj.year})</h4>
          <div className="tract-projection-grid">
            {METRICS.map((m) => (
              <div key={m.key} className="tract-projection-item">
                <span className="proj-label">{m.label}</span>
                <span className="proj-value">{m.format(latestProj[m.key])}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
