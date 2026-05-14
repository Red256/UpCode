import { useState, useEffect, useRef, useMemo } from 'react';
import { Chart } from 'chart.js/auto';
import { fetchTractHistory, projectFuture } from '../utils/censusApi';
import { featureAreaSqMi } from '../utils/tractAreaUnits';
import { formatMedianHomeValueDisplay } from '../utils/censusConstants';

export default function TractDetailPanel({ tract, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [projections, setProjections] = useState([]);
  const [activeMetric, setActiveMetric] = useState('income');
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  const tractLandSqMi = useMemo(() => (tract ? featureAreaSqMi(tract) : 0), [tract]);

  const metricsConfig = useMemo(
    () => [
      { key: 'income', label: 'Median Income', format: (v) => (v ? `$${Math.round(v).toLocaleString()}` : '—'), color: '#2563eb' },
      { key: 'rent', label: 'Median Rent', format: (v) => (v ? `$${Math.round(v).toLocaleString()}` : '—'), color: '#16a34a' },
      { key: 'homeValue', label: 'Home Value', format: (v) => formatMedianHomeValueDisplay(v), color: '#a855f7' },
      {
        key: 'studentPopulation',
        label: 'Student Density',
        format: (v) => {
          if (v == null || Number.isNaN(v) || tractLandSqMi <= 0) return '—';
          const r = Number(v) / tractLandSqMi;
          return `${r.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 })} / sq mi`;
        },
        color: '#f59e0b',
      },
    ],
    [tractLandSqMi],
  );

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
    const metric = metricsConfig.find((m) => m.key === activeMetric);

    // Filter out entries where the active metric is null
    const validData = allData.filter((d) => d[activeMetric] != null);

    if (validData.length === 0) {
      // No valid data for this metric, don't render chart
      return;
    }

    const labels = validData.map((d) => d.year);
    const values = validData.map((d) => {
      const raw = d[activeMetric];
      if (activeMetric === 'studentPopulation' && tractLandSqMi > 0 && raw != null) {
        return raw / tractLandSqMi;
      }
      return raw;
    });
    const isProjected = validData.map((d) => d.projected);

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
                if (v == null) return '';
                // Chart stores density for students; metric.format() expects raw headcount — don't double-divide
                let formatted;
                if (activeMetric === 'studentPopulation') {
                  formatted = `${Number(v).toLocaleString('en-US', {
                    maximumFractionDigits: 1,
                    minimumFractionDigits: 0,
                  })} / sq mi`;
                } else {
                  formatted = metric?.format(v) ?? String(v);
                }
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
                if (v == null) return '';
                if (activeMetric === 'studentPopulation') return `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} /sq mi`;
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
  }, [history, projections, activeMetric, metricsConfig, tractLandSqMi]);

  if (!tract) return null;

  const raw = tract.properties?.raw || {};
  const name = raw.name || tract.properties?.NAME || 'Census Tract';

  const latestProj = projections[projections.length - 1];

  const getTrend = (key) => {
    if (history.length < 2) return null;
    const first = history.find((h) => h[key] != null);
    const last = [...history].reverse().find((h) => h[key] != null);
    if (!first || !last || first === last) return null;
    if (first[key] === 0) return null; // Avoid division by zero
    const change = ((last[key] - first[key]) / first[key]) * 100;
    // Filter out extreme values (likely data errors)
    if (!Number.isFinite(change) || Math.abs(change) > 10000) return null;
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
          {metricsConfig.map((m) => {
            const val = raw[m.key];
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
            {metricsConfig.map((m) => (
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
