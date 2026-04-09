import { useMemo, useCallback, useRef, useEffect } from "react";
import { GeoJSON } from "react-leaflet";
import { colorForHeatmapScore } from "../utils/tractHeatmap";

export default function TractHeatmapLayer({ data, metricField, onTractClick }) {
  const onTractClickRef = useRef(onTractClick);
  useEffect(() => {
    onTractClickRef.current = onTractClick;
  }, [onTractClick]);

  const style = useMemo(() => {
    return (feature) => {
      const s = feature.properties.scores?.[metricField];
      return {
        fillColor: colorForHeatmapScore(s),
        fillOpacity: 0.52,
        color: "#0f172a",
        weight: 0.45,
        opacity: 0.88,
      };
    };
  }, [metricField]);

  const onEachFeature = useCallback((feature, layer) => {
    const r = feature.properties.raw || {};
    const name = r.name || feature.properties.NAME || "—";
    const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
    const fmtMoney = (n) => (n == null ? "—" : `$${fmt(n)}`);
    const edu =
      r.schoolProxy != null && !Number.isNaN(r.schoolProxy)
        ? `${r.schoolProxy.toFixed(1)}%`
        : "—";
    const html = `<div style="font-size:12px;min-width:200px;font-family:system-ui,sans-serif">
<div style="font-weight:600;margin-bottom:6px">${name}</div>
<div>Median income: ${fmtMoney(r.income)}</div>
<div>Median gross rent: ${fmtMoney(r.rent)}</div>
<div>Median home value: ${fmtMoney(r.homeValue)}</div>
<div>25+ with bachelor's or higher: ${edu}</div>
<div style="margin-top:8px;font-size:11px;color:#6b7280">Click for trends &amp; projections</div>
</div>`;
    layer.bindPopup(html);

    layer.on('click', () => {
      if (onTractClickRef.current) {
        onTractClickRef.current(feature);
      }
    });
  }, []);

  if (!data?.features?.length) return null;

  return (
    <GeoJSON
      key={`${metricField}-${data.features.length}`}
      data={data}
      style={style}
      onEachFeature={onEachFeature}
    />
  );
}
