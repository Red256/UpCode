import { jsPDF } from 'jspdf';
import { Chart } from 'chart.js/auto';

/** mm — comfortable print margins (jsPDF default unit is mm for A4) */
const MARGIN = 22;
const FOOTER_H = 26;
const HEADER_H = 20;

function contentBottom(pdf) {
  return pdf.internal.pageSize.getHeight() - FOOTER_H;
}

function pageWidth(pdf) {
  return pdf.internal.pageSize.getWidth();
}

/** Full content width; height from aspect ratio (no horizontal letterboxing). */
function pdfImageFullWidth(innerW, innerH, contentW) {
  const iw = Number(innerW);
  const ih = Number(innerH);
  if (!iw || !ih || iw <= 0 || ih <= 0) {
    return { drawW: contentW, drawH: 40 };
  }
  return { drawW: contentW, drawH: (contentW * ih) / iw };
}

/**
 * splitTextToSize can still emit lines wider than maxW for some glyphs / long tokens.
 * Hard-break any over-wide line so nothing draws past the box edge.
 */
function splitTextToSizeSafe(pdf, text, maxW) {
  const raw = pdf.splitTextToSize(String(text), maxW);
  const out = [];
  for (const line of raw) {
    if (pdf.getTextWidth(line) <= maxW + 0.5) {
      out.push(line);
      continue;
    }
    let chunk = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = chunk + ch;
      if (pdf.getTextWidth(next) > maxW && chunk.length > 0) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk = next;
      }
    }
    if (chunk.length) out.push(chunk);
  }
  return out;
}

/** Round scores and numeric displays for PDF */
function fmtScore(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return '—';
  return String(Math.round(v));
}

function fmtCoord(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return '—';
  return v.toFixed(3);
}

function fmtWeight(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function fmtRawValue(raw) {
  if (raw == null || raw === '') return '—';
  const s = String(raw);
  const num = parseFloat(s.replace(/[$,]/g, ''));
  if (!Number.isNaN(num) && s.match(/^\$?[\d.,]+$/)) {
    if (num >= 1000) return `$${Math.round(num).toLocaleString('en-US')}`;
    return `$${Math.round(num)}`;
  }
  return s.length > 42 ? `${s.slice(0, 39)}…` : s;
}

function fmtDistance(mi) {
  const v = Number(mi);
  if (Number.isNaN(v)) return '—';
  return v.toFixed(1);
}

/** Center text inside a filled circle at (cx, cy) with radius r */
function drawCircleBadge(pdf, text, cx, cy, r, fillRgb, textRgb = [255, 255, 255]) {
  const str = String(text);
  pdf.setFillColor(...fillRgb);
  pdf.circle(cx, cy, r, 'F');
  pdf.setTextColor(...textRgb);
  pdf.setFont('helvetica', 'bold');
  let size = Math.min(9, Math.max(6, r * 1.45));
  pdf.setFontSize(size);
  while (pdf.getTextWidth(str) > 2 * r - 1.2 && size > 5) {
    size -= 0.5;
    pdf.setFontSize(size);
  }
  pdf.text(str, cx, cy, { align: 'center', baseline: 'middle' });
}

const COLORS = {
  primary: [37, 99, 235],
  primaryLight: [59, 130, 246],
  success: [16, 185, 129],
  warning: [245, 158, 11],
  danger: [239, 68, 68],
  gray: [107, 114, 128],
  grayLight: [243, 244, 246],
  grayDark: [31, 41, 55],
  white: [255, 255, 255],
  black: [0, 0, 0]
};

const FACTOR_COLORS = {
  'Median Income': [59, 130, 246],
  'Median Rent': [16, 185, 129],
  'Median Home Value': [168, 85, 247],
  School: [251, 146, 60]
};

function getScoreColor(score) {
  if (score >= 75) return COLORS.success;
  if (score >= 60) return COLORS.primaryLight;
  if (score >= 40) return COLORS.warning;
  return COLORS.danger;
}

function getVerdict(score) {
  if (score >= 75) return { text: 'Excellent', desc: 'Prime location with outstanding metrics' };
  if (score >= 60) return { text: 'Good', desc: 'Solid fundamentals with growth potential' };
  if (score >= 40) return { text: 'Fair', desc: 'Moderate potential, consider alternatives' };
  return { text: 'Poor', desc: 'Below average, significant concerns' };
}

function drawRoundedRect(pdf, x, y, w, h, r, style = 'F') {
  pdf.roundedRect(x, y, w, h, r, r, style);
}

function addPageFooter(pdf, pageNum, totalPages) {
  const w = pageWidth(pdf);
  const h = pdf.internal.pageSize.getHeight();
  pdf.setDrawColor(...COLORS.grayLight);
  pdf.setLineWidth(0.3);
  pdf.line(MARGIN, h - 18, w - MARGIN, h - 18);
  pdf.setFontSize(7);
  pdf.setTextColor(...COLORS.gray);
  pdf.setFont('helvetica', 'normal');
  pdf.text('FranchiseFit Location Intelligence Report', MARGIN, h - 9);
  pdf.text(`Page ${pageNum} of ${totalPages}`, w - MARGIN, h - 9, { align: 'right' });
  pdf.text('Confidential', w / 2, h - 9, { align: 'center' });
}

async function createChart(type, labels, data, title, width = 400, height = 220) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.position = 'absolute';
  canvas.style.left = '-9999px';
  document.body.appendChild(canvas);

  const colors = labels.map((label) => FACTOR_COLORS[label] || COLORS.primaryLight);

  const config =
    type === 'radar'
      ? {
          type: 'radar',
          data: {
            labels,
            datasets: [
              {
                label: 'Score',
                data,
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                borderColor: 'rgba(59, 130, 246, 1)',
                borderWidth: 2,
                pointBackgroundColor: 'rgba(59, 130, 246, 1)',
                pointBorderColor: '#fff'
              }
            ]
          },
          options: {
            responsive: false,
            animation: false,
            scales: {
              r: {
                beginAtZero: true,
                max: 100,
                ticks: { stepSize: 25 }
              }
            },
            plugins: {
              legend: { display: false },
              title: { display: true, text: title, font: { size: 12, weight: 'bold' } }
            }
          }
        }
      : {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                data,
                backgroundColor: colors.map((c) => `rgba(${c.join(',')}, 0.75)`),
                borderColor: colors.map((c) => `rgba(${c.join(',')}, 1)`),
                borderWidth: 1.5,
                borderRadius: 4
              }
            ]
          },
          options: {
            responsive: false,
            animation: false,
            indexAxis: 'y',
            plugins: {
              legend: { display: false },
              title: { display: true, text: title, font: { size: 12, weight: 'bold' } }
            },
            scales: {
              x: { beginAtZero: true, max: 100, ticks: { precision: 0 } },
              y: { grid: { display: false } }
            }
          }
        };

  const chart = new Chart(canvas, config);
  await new Promise((r) => setTimeout(r, 150));
  const imgData = canvas.toDataURL('image/png');
  chart.destroy();
  document.body.removeChild(canvas);
  return imgData;
}

/** Match censusApi NATIONAL_BENCHMARKS for normalized 0–100 trend lines on one chart */
const TREND_BENCH = {
  income: { min: 25000, max: 150000 },
  rent: { min: 500, max: 2500 },
  homeValue: { min: 100000, max: 800000 },
  education: { min: 10, max: 60 }
};

function normTrendScore(val, bench) {
  if (val == null || Number.isNaN(val)) return null;
  const { min, max } = bench;
  const clamped = Math.max(min, Math.min(max, val));
  return Math.round(((clamped - min) / (max - min)) * 100);
}

async function createTrendLineChart(history, title) {
  const canvas = document.createElement('canvas');
  canvas.width = 520;
  canvas.height = 240;
  canvas.style.position = 'absolute';
  canvas.style.left = '-9999px';
  document.body.appendChild(canvas);

  const labels = history.map((h) => String(h.year));
  const datasets = [
    {
      label: 'Income',
      data: history.map((h) => normTrendScore(h.income, TREND_BENCH.income)),
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'rgba(59, 130, 246, 0.06)',
      tension: 0.2,
      borderWidth: 2,
      pointRadius: 3,
      spanGaps: true
    },
    {
      label: 'Rent',
      data: history.map((h) => normTrendScore(h.rent, TREND_BENCH.rent)),
      borderColor: 'rgb(16, 185, 129)',
      backgroundColor: 'rgba(16, 185, 129, 0.06)',
      tension: 0.2,
      borderWidth: 2,
      pointRadius: 3,
      spanGaps: true
    },
    {
      label: 'Home value',
      data: history.map((h) => normTrendScore(h.homeValue, TREND_BENCH.homeValue)),
      borderColor: 'rgb(168, 85, 247)',
      backgroundColor: 'rgba(168, 85, 247, 0.06)',
      tension: 0.2,
      borderWidth: 2,
      pointRadius: 3,
      spanGaps: true
    },
    {
      label: 'Education',
      data: history.map((h) => normTrendScore(h.education, TREND_BENCH.education)),
      borderColor: 'rgb(251, 146, 60)',
      backgroundColor: 'rgba(251, 146, 60, 0.06)',
      tension: 0.2,
      borderWidth: 2,
      pointRadius: 3,
      spanGaps: true
    }
  ];

  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 9 } } },
        title: { display: true, text: title, font: { size: 11, weight: 'bold' } }
      },
      scales: {
        y: { beginAtZero: true, max: 100, ticks: { stepSize: 25 } },
        x: { ticks: { maxRotation: 0 } }
      }
    }
  });
  await new Promise((r) => setTimeout(r, 160));
  const imgData = canvas.toDataURL('image/png');
  chart.destroy();
  document.body.removeChild(canvas);
  return imgData;
}

function buildTrendNarrativeBullets(history) {
  if (!history || history.length < 2) return [];
  const first = history[0];
  const last = history[history.length - 1];
  const out = [];
  const pct = (a, b) => {
    if (a == null || b == null || b === 0) return null;
    return Math.round((100 * (a - b)) / Math.abs(b));
  };
  const pi = pct(last.income, first.income);
  const pr = pct(last.rent, first.rent);
  const ph = pct(last.homeValue, first.homeValue);
  const pe = pct(last.education, first.education);
  if (pi != null) {
    out.push(
      `Median household income ${pi >= 0 ? 'rose' : 'fell'} about ${Math.abs(pi)}% from ${first.year} to ${last.year} (county ACS 5-year).`
    );
  }
  if (pr != null) {
    out.push(`Median gross rent ${pr >= 0 ? 'increased' : 'decreased'} about ${Math.abs(pr)}% over the same span.`);
  }
  if (ph != null) {
    out.push(`Median home value ${ph >= 0 ? 'increased' : 'decreased'} about ${Math.abs(ph)}%.`);
  }
  if (pe != null) {
    out.push(
      `Share of adults 25+ with bachelor's or higher ${pe >= 0 ? 'rose' : 'fell'} about ${Math.abs(pe)} percentage points (relative to the earlier estimate).`
    );
  }
  return out.slice(0, 4);
}

function fmtTrendUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `$${Math.round(Number(n)).toLocaleString('en-US')}`;
}

function fmtTrendEdu(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

/** Match App weighted overall for projected factor scores (when only raw projection object is available). */
function weightedOverallFromProjection(factors, factorScores) {
  const enabled = Object.entries(factors).filter(([, f]) => f.enabled);
  if (enabled.length === 0) return null;
  let weightedSum = 0;
  let totalWeight = 0;
  enabled.forEach(([key, factor]) => {
    const weight = factor.value;
    const score = Number(factorScores[key] ?? 0);
    weightedSum += score * weight;
    totalWeight += weight;
  });
  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

export async function generateLocationReport(
  locationName,
  analysisResult,
  factors,
  radiusMi,
  center,
  suggestions = [],
  mapSnapshot = null,
  trendData = null
) {
  const pdf = new jsPDF();
  const w = pageWidth(pdf);
  const bottom = contentBottom(pdf);
  const score = Math.round(Number(analysisResult.overall) || 0);
  const verdict = getVerdict(score);
  const enabledFactors = Object.entries(factors).filter(([, f]) => f.enabled);
  const factorLabels = enabledFactors.map(([key]) => key);
  const factorScores = enabledFactors.map(([key]) => Math.round(Number(analysisResult.factorScores[key]) || 0));

  // ----- PAGE 1: Cover + location + optional full-width map (map pushes executive summary to page 2) -----
  pdf.setFillColor(...COLORS.primary);
  pdf.rect(0, 0, w, 52, 'F');
  pdf.setFillColor(30, 64, 175);
  pdf.rect(0, 48, w, 4, 'F');

  pdf.setTextColor(...COLORS.white);
  pdf.setFontSize(22);
  pdf.setFont('helvetica', 'bold');
  pdf.text('FranchiseFit', MARGIN, 24);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  pdf.text('Location Intelligence Report', MARGIN, 36);

  pdf.setFillColor(...COLORS.white);
  drawRoundedRect(pdf, w - 62, 14, 48, 18, 2);
  pdf.setTextColor(...COLORS.primary);
  pdf.setFontSize(7);
  pdf.text('Generated', w - 56, 22);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text(new Date().toLocaleDateString(), w - 56, 28);

  pdf.setTextColor(...COLORS.grayDark);
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.text('LOCATION ANALYSIS FOR', MARGIN, 64);

  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  const titleMaxW = w - 2 * MARGIN;
  const titleLines = splitTextToSizeSafe(pdf, locationName || 'Unknown', titleMaxW);
  let y = 72;
  const titleLineH = 6;
  titleLines.slice(0, 4).forEach((line) => {
    pdf.text(line, MARGIN, y);
    y += titleLineH;
  });

  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(...COLORS.gray);
  const metaLine = `Coordinates: ${fmtCoord(center[0])}, ${fmtCoord(center[1])}  ·  Radius: ${fmtWeight(radiusMi)} mi`;
  const metaLines = splitTextToSizeSafe(pdf, metaLine, titleMaxW);
  metaLines.forEach((ln, i) => {
    pdf.text(ln, MARGIN, y + 2 + i * 4);
  });
  y += 2 + metaLines.length * 4;

  y += 8;
  pdf.setDrawColor(...COLORS.grayLight);
  pdf.line(MARGIN, y, w - MARGIN, y);
  y += 10;

  if (mapSnapshot?.dataUrl) {
    pdf.setTextColor(...COLORS.grayDark);
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Site map', MARGIN, y);
    y += 7;
    const contentW = w - 2 * MARGIN;
    const { drawW, drawH } = pdfImageFullWidth(mapSnapshot.width, mapSnapshot.height, contentW);
    try {
      const imgFmt = mapSnapshot.dataUrl.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG';
      pdf.addImage(mapSnapshot.dataUrl, imgFmt, MARGIN, y, drawW, drawH);
    } catch {
      /* invalid or unsupported image data */
    }
    y += drawH + 3;
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(...COLORS.gray);
    const mapCap = splitTextToSizeSafe(
      pdf,
      `Pin: site center · Blue circle: ${fmtWeight(radiusMi)} mi analysis radius · © OpenStreetMap contributors`,
      titleMaxW
    );
    mapCap.forEach((ln, i) => {
      pdf.text(ln, MARGIN, y + i * 3.5);
    });
    y += mapCap.length * 3.5 + 6;
    pdf.addPage();
    y = MARGIN + 12;
  }

  pdf.setTextColor(...COLORS.grayDark);
  pdf.setFontSize(12);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Executive Summary', MARGIN, y);
  y += 10;

  const scoreColor = getScoreColor(score);
  const boxW = 72;
  const boxH = 44;
  pdf.setFillColor(...scoreColor);
  drawRoundedRect(pdf, MARGIN, y, boxW, boxH, 4);

  pdf.setTextColor(...COLORS.white);
  pdf.setFontSize(28);
  pdf.setFont('helvetica', 'bold');
  pdf.text(String(score), MARGIN + boxW / 2, y + boxH / 2 - 2, { align: 'center', baseline: 'middle' });
  pdf.setFontSize(8);
  pdf.text('OVERALL SCORE', MARGIN + boxW / 2, y + boxH - 8, { align: 'center' });

  const rightX = MARGIN + boxW + 12;
  pdf.setTextColor(...COLORS.grayDark);
  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text(verdict.text, rightX, y + 12);
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(...COLORS.gray);
  const descMaxW = w - rightX - MARGIN;
  const descLines = splitTextToSizeSafe(pdf, verdict.desc, descMaxW);
  let vy = y + 20;
  descLines.slice(0, 4).forEach((ln) => {
    pdf.text(ln, rightX, vy);
    vy += 5;
  });

  const maxF = enabledFactors.reduce(
    (acc, [key], i) => (factorScores[i] > acc.score ? { name: key, score: factorScores[i] } : acc),
    { name: '—', score: -1 }
  );
  const minF = enabledFactors.reduce(
    (acc, [key], i) => (factorScores[i] < acc.score ? { name: key, score: factorScores[i] } : acc),
    { name: '—', score: 101 }
  );
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  const swLine1 = `Strongest: ${maxF.name} (${fmtScore(maxF.score)})`;
  const swLine2 = `Weakest: ${minF.name} (${fmtScore(minF.score)})`;
  const sw1 = splitTextToSizeSafe(pdf, swLine1, descMaxW);
  const sw2 = splitTextToSizeSafe(pdf, swLine2, descMaxW);
  let swy = vy + 4;
  sw1.forEach((ln) => {
    pdf.text(ln, rightX, swy);
    swy += 4;
  });
  sw2.forEach((ln) => {
    pdf.text(ln, rightX, swy);
    swy += 4;
  });

  y = Math.max(y + boxH, swy + 4) + 12;
  pdf.setFillColor(...COLORS.grayLight);
  const insights = generateInsights(score, enabledFactors, analysisResult);
  const insightPadX = 6;
  const insightTextW = w - 2 * MARGIN - 2 * insightPadX;
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  let insightLineCount = 0;
  insights.forEach((ins) => {
    insightLineCount += splitTextToSizeSafe(pdf, `• ${ins}`, insightTextW).length;
  });
  const lineHInsight = 4.5;
  const insightBodyH = insightLineCount * lineHInsight;
  const neededInsightH = 18 + insightBodyH + 8;
  const insightBoxH = Math.min(neededInsightH, bottom - y - 10);
  drawRoundedRect(pdf, MARGIN, y, w - 2 * MARGIN, insightBoxH, 3);

  pdf.setTextColor(...COLORS.grayDark);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Key Insights', MARGIN + insightPadX, y + 8);

  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(...COLORS.gray);
  let iy = y + 16;
  insights.forEach((ins) => {
    const wrapped = splitTextToSizeSafe(pdf, `• ${ins}`, insightTextW);
    wrapped.forEach((line) => {
      if (iy <= y + insightBoxH - 3) {
        pdf.text(line, MARGIN + insightPadX, iy);
        iy += lineHInsight;
      }
    });
  });

  pdf.setFontSize(8);
  pdf.setTextColor(...COLORS.gray);
  pdf.text('Factor overview continues on the next page.', MARGIN, bottom - 4);

  // ----- PAGE 2: Factor table + charts -----
  pdf.addPage();
  pdf.setFillColor(...COLORS.primary);
  pdf.rect(0, 0, w, HEADER_H, 'F');
  pdf.setTextColor(...COLORS.white);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Factor Overview & Charts', MARGIN, 13);

  y = HEADER_H + 8;
  pdf.setTextColor(...COLORS.grayDark);
  pdf.setFontSize(10);
  pdf.text('Factor Overview', MARGIN, y);
  y += 7;

  const tableW = w - 2 * MARGIN;
  const colFactor = MARGIN;
  const colScore = MARGIN + tableW * 0.48;
  const colVal = MARGIN + tableW * 0.62;
  const colWt = w - MARGIN - 14;
  const HEADER_H_ROW = 9;
  const LINE_H = 4.2;

  pdf.setFillColor(...COLORS.primary);
  pdf.rect(MARGIN, y, tableW, HEADER_H_ROW, 'F');
  pdf.setTextColor(...COLORS.white);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'bold');
  const headerTextY = y + HEADER_H_ROW / 2 + 1.5;
  pdf.text('Factor', colFactor + 2, headerTextY);
  pdf.text('Score', colScore, headerTextY);
  pdf.text('Value', colVal, headerTextY);
  pdf.text('Wt', colWt, headerTextY);
  y += HEADER_H_ROW + 1;

  enabledFactors.forEach(([key, factor], index) => {
    const fs = Math.round(Number(analysisResult.factorScores[key]) || 0);
    const rawVal = fmtRawValue(analysisResult.raw_values[key]?.raw_value);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    const nameW = Math.max(18, colScore - colFactor - 4);
    const valW = Math.max(14, colWt - colVal - 6);
    const nameLines = splitTextToSizeSafe(pdf, key, nameW);
    const valLines = splitTextToSizeSafe(pdf, rawVal, valW);
    const linesInRow = Math.max(nameLines.length, valLines.length, 1);
    const rowH = Math.max(9, 6 + (linesInRow - 1) * LINE_H);

    if (y + rowH > bottom - 8) {
      pdf.addPage();
      pdf.setFillColor(...COLORS.primary);
      pdf.rect(0, 0, w, HEADER_H, 'F');
      pdf.setTextColor(...COLORS.white);
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Factor Overview (continued)', MARGIN, 13);
      y = HEADER_H + 6;
      pdf.setFillColor(...COLORS.primary);
      pdf.rect(MARGIN, y, tableW, HEADER_H_ROW, 'F');
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      const contHeaderY = y + HEADER_H_ROW / 2 + 1.5;
      pdf.text('Factor', colFactor + 2, contHeaderY);
      pdf.text('Score', colScore, contHeaderY);
      pdf.text('Value', colVal, contHeaderY);
      pdf.text('Wt', colWt, contHeaderY);
      y += HEADER_H_ROW + 1;
    }

    const rowTop = y;
    if (index % 2 === 0) {
      pdf.setFillColor(249, 250, 251);
      pdf.rect(MARGIN, rowTop, tableW, rowH, 'F');
    }

    pdf.setTextColor(...COLORS.grayDark);
    let lineY = rowTop + 6;
    nameLines.forEach((nl) => {
      pdf.text(nl, colFactor + 2, lineY);
      lineY += LINE_H;
    });

    const scoreMidY = rowTop + rowH / 2 + 1.5;
    pdf.setTextColor(...getScoreColor(fs));
    pdf.setFont('helvetica', 'bold');
    pdf.text(fmtScore(fs), colScore, scoreMidY);

    pdf.setTextColor(...COLORS.grayDark);
    pdf.setFont('helvetica', 'normal');
    lineY = rowTop + 6;
    valLines.forEach((vl) => {
      pdf.text(vl, colVal, lineY);
      lineY += LINE_H;
    });
    pdf.text(fmtWeight(factor.value), colWt, scoreMidY);

    y = rowTop + rowH + 0.5;
  });

  y += 6;
  if (y > bottom - 100) {
    pdf.addPage();
    y = HEADER_H + 8;
  }

  const barChart = await createChart('bar', factorLabels, factorScores, 'Factor scores', 480, 200);
  const chartW = w - 2 * MARGIN;
  const chartH = 64;
  pdf.addImage(barChart, 'PNG', MARGIN, y, chartW, chartH);
  y += chartH + 8;

  if (y > bottom - 110) {
    pdf.addPage();
    y = HEADER_H + 8;
  }

  const radarChart = await createChart('radar', factorLabels, factorScores, 'Balance', 280, 240);
  const radarSize = 78;
  const rx = MARGIN + (chartW - radarSize) / 2;
  pdf.addImage(radarChart, 'PNG', rx, y, radarSize, radarSize);
  y += radarSize + 10;

  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Individual factors', MARGIN, y);
  y += 6;

  enabledFactors.forEach(([key]) => {
    const fs = Math.round(Number(analysisResult.factorScores[key]) || 0);
    const rawVal = fmtRawValue(analysisResult.raw_values[key]?.raw_value);
    const fcol = FACTOR_COLORS[key] || COLORS.primary;
    const textAreaW = w - 2 * MARGIN - 56;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    const keyLines = splitTextToSizeSafe(pdf, key, textAreaW);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    const detailLines = splitTextToSizeSafe(
      pdf,
      `Score ${fmtScore(fs)}  ·  ${rawVal}`,
      textAreaW
    );
    const keyLineH = 4.2;
    const detailLineH = 4;
    const rowH = Math.max(16, 8 + keyLines.length * keyLineH + detailLines.length * detailLineH);

    if (y + rowH > bottom) {
      pdf.addPage();
      y = HEADER_H + 8;
    }

    pdf.setFillColor(249, 250, 251);
    drawRoundedRect(pdf, MARGIN, y, w - 2 * MARGIN, rowH, 2);
    pdf.setFillColor(...fcol);
    pdf.rect(MARGIN, y, 3, rowH, 'F');

    pdf.setTextColor(...COLORS.grayDark);
    let ly = y + 6;
    keyLines.forEach((kl) => {
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'bold');
      pdf.text(kl, MARGIN + 8, ly);
      ly += keyLineH;
    });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...COLORS.gray);
    detailLines.forEach((dl) => {
      pdf.text(dl, MARGIN + 8, ly);
      ly += detailLineH;
    });

    const barY = y + rowH / 2 - 2.5;
    pdf.setFillColor(229, 231, 235);
    pdf.rect(w - MARGIN - 48, barY, 40, 5, 'F');
    pdf.setFillColor(...getScoreColor(fs));
    pdf.rect(w - MARGIN - 48, barY, (40 * fs) / 100, 5, 'F');

    y += rowH + 4;
  });

  // ----- PAGE: Historical trends & future outlook -----
  const hasHistory =
    trendData && Array.isArray(trendData.history) && trendData.history.length > 0;
  const projUi = analysisResult?.projection;
  const projRaw = trendData?.projection;
  const showTrendsPage = hasHistory || projUi || projRaw;

  if (showTrendsPage) {
    pdf.addPage();
    pdf.setFillColor(...COLORS.primary);
    pdf.rect(0, 0, w, HEADER_H, 'F');
    pdf.setTextColor(...COLORS.white);
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Historical trends & future outlook', MARGIN, 13);

    let ty = HEADER_H + 10;
    const innerW = w - 2 * MARGIN;

    const ensureSpace = (needMm) => {
      if (ty + needMm <= bottom) return;
      pdf.addPage();
      pdf.setFillColor(...COLORS.primary);
      pdf.rect(0, 0, w, HEADER_H, 'F');
      pdf.setTextColor(...COLORS.white);
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Historical trends & future outlook (continued)', MARGIN, 13);
      ty = HEADER_H + 10;
    };

    if (hasHistory) {
      const hist = trendData.history;
      const y0 = hist[0].year;
      const y1 = hist[hist.length - 1].year;
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...COLORS.grayDark);
      pdf.text('Past: county ACS trend', MARGIN, ty);
      ty += 7;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(...COLORS.gray);
      const pastIntro = `${trendData.countyName || 'County'} · ACS 5-year estimates · ${y0}–${y1}. These series describe the county surrounding your pin; tract-level values on the map may differ.`;
      splitTextToSizeSafe(pdf, pastIntro, innerW).forEach((ln) => {
        ensureSpace(5);
        pdf.text(ln, MARGIN, ty);
        ty += 4.2;
      });
      ty += 4;

      ensureSpace(28);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7.5);
      pdf.setTextColor(...COLORS.grayDark);
      const cx = [MARGIN, MARGIN + 16, MARGIN + 52, MARGIN + 90, MARGIN + 128];
      pdf.text('Year', cx[0], ty);
      pdf.text('Med. income', cx[1], ty);
      pdf.text('Med. rent', cx[2], ty);
      pdf.text('Med. home', cx[3], ty);
      pdf.text('Bach.+ %', cx[4], ty);
      ty += 5;
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(...COLORS.gray);
      pdf.setFontSize(7.5);
      hist.forEach((row) => {
        ensureSpace(6);
        pdf.text(String(row.year), cx[0], ty);
        pdf.text(fmtTrendUsd(row.income), cx[1], ty);
        pdf.text(fmtTrendUsd(row.rent), cx[2], ty);
        pdf.text(fmtTrendUsd(row.homeValue), cx[3], ty);
        pdf.text(fmtTrendEdu(row.education), cx[4], ty);
        ty += 4.5;
      });
      ty += 6;

      if (hist.length >= 2) {
        ensureSpace(95);
        const chartTitle = 'Normalized factor strength (0–100, national benchmarks)';
        const chartImg = await createTrendLineChart(hist, chartTitle);
        const chartW = innerW;
        const chartH = (240 / 520) * chartW;
        try {
          pdf.addImage(chartImg, 'PNG', MARGIN, ty, chartW, chartH);
        } catch {
          /* ignore */
        }
        ty += chartH + 8;

        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(...COLORS.grayDark);
        pdf.text('Summary of change (first vs last year in table)', MARGIN, ty);
        ty += 5;
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(...COLORS.gray);
        const bullets = buildTrendNarrativeBullets(hist);
        if (bullets.length === 0) {
          ensureSpace(5);
          pdf.text('Not enough comparable years to summarize percent change.', MARGIN, ty);
          ty += 4;
        } else {
          bullets.forEach((b) => {
            const lines = splitTextToSizeSafe(pdf, `• ${b}`, innerW - 4);
            lines.forEach((ln) => {
              ensureSpace(5);
              pdf.text(ln, MARGIN + 2, ty);
              ty += 4;
            });
          });
        }
        ty += 4;
      }
    }

    const futureProj = projUi
      ? { kind: 'ui', data: projUi }
      : projRaw?.factorScores
        ? { kind: 'raw', data: projRaw }
        : null;

    if (futureProj) {
      ensureSpace(42);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...COLORS.grayDark);
      const hy = futureProj.data.horizonYear;
      pdf.text(`Future: projected scores (${hy})`, MARGIN, ty);
      ty += 7;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(...COLORS.gray);
      const note =
        futureProj.kind === 'ui'
          ? futureProj.data.sourceNote
          : `Linear extrapolation of county-level ACS metrics through ${hy}, using the same method as the app. Not a forecast of market cycles or business outcomes.`;
      splitTextToSizeSafe(pdf, note, innerW).forEach((ln) => {
        ensureSpace(5);
        pdf.text(ln, MARGIN, ty);
        ty += 4;
      });
      ty += 4;

      let projOverall =
        futureProj.kind === 'ui' ? futureProj.data.overall : null;
      if (projOverall == null && futureProj.kind === 'raw') {
        projOverall = weightedOverallFromProjection(factors, futureProj.data.factorScores);
      }
      if (projOverall != null) {
        ensureSpace(6);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(...COLORS.grayDark);
        pdf.text(`Projected weighted overall (your factor weights): ${fmtScore(projOverall)}/100`, MARGIN, ty);
        ty += 5;
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(...COLORS.gray);
      }
      if (futureProj.kind === 'ui' && futureProj.data.deltaOverall != null) {
        ensureSpace(5);
        const d = futureProj.data.deltaOverall;
        const dir = d >= 0 ? 'higher' : 'lower';
        pdf.text(
          `Versus today's weighted score: ${d >= 0 ? '+' : ''}${fmtScore(d)} points (${dir} in ${hy}).`,
          MARGIN,
          ty
        );
        ty += 5;
      }

      const fs = futureProj.data.factorScores;
      const rawVals =
        futureProj.kind === 'ui' ? futureProj.data.raw_values : futureProj.data.rawValues;
      if (fs && rawVals) {
        ensureSpace(8 + enabledFactors.length * 5);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(...COLORS.grayDark);
        pdf.text('Projected factor scores & values', MARGIN, ty);
        ty += 5;
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(...COLORS.gray);
        enabledFactors.forEach(([key]) => {
          ensureSpace(6);
          const sc = fs[key];
          let rawStr = '—';
          if (futureProj.kind === 'ui') {
            const b = rawVals[key];
            rawStr = b?.raw_value != null ? String(b.raw_value) : '—';
          } else {
            rawStr = rawVals[key] != null ? String(rawVals[key]) : '—';
          }
          const line = `${key}: score ${fmtScore(sc)} · ${rawStr}`;
          splitTextToSizeSafe(pdf, line, innerW).forEach((ln) => {
            pdf.text(ln, MARGIN, ty);
            ty += 4;
          });
        });
      }
    } else if (!hasHistory) {
      pdf.setFontSize(8);
      pdf.setTextColor(...COLORS.gray);
      pdf.text(
        'No historical or projection detail was available for this export.',
        MARGIN,
        ty
      );
    }
  }

  // ----- PAGE: Recommendations -----
  pdf.addPage();
  pdf.setFillColor(...COLORS.primary);
  pdf.rect(0, 0, w, HEADER_H, 'F');
  pdf.setTextColor(...COLORS.white);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Recommendations & Action Plan', MARGIN, 13);

  y = HEADER_H + 10;
  pdf.setTextColor(...COLORS.grayDark);
  pdf.setFontSize(12);
  pdf.text('Overall assessment', MARGIN, y);
  y += 8;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  const assessLines = splitTextToSizeSafe(pdf, getOverallAssessment(score), w - 2 * MARGIN - 12);
  const assessLineH = 4;
  const assessBoxH = Math.max(24, 12 + assessLines.length * assessLineH + 6);
  pdf.setFillColor(...getScoreColor(score));
  drawRoundedRect(pdf, MARGIN, y, w - 2 * MARGIN, assessBoxH, 3);
  pdf.setTextColor(...COLORS.white);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`${verdict.text.toUpperCase()} · ${fmtScore(score)}/100`, MARGIN + 6, y + 9);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  let ay = y + 16;
  assessLines.forEach((ln) => {
    pdf.text(ln, MARGIN + 6, ay);
    ay += assessLineH;
  });
  y += assessBoxH + 8;

  const { strengths, weaknesses } = analyzeStrengthsWeaknesses(enabledFactors, analysisResult);
  const colW = (w - 2 * MARGIN - 8) / 2;
  const boxPadX = 5;
  /** Extra margin so wrapped lines never touch rounded rect edge (Helvetica metrics + rounding). */
  const wrapW = Math.max(24, colW - 2 * boxPadX - 6);
  const bulletLineH = 4;
  const gapBetweenBullets = 2;

  const measureColumn = (items, prefix) => {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    let h = boxPadX;
    items.forEach((item, i) => {
      const lines = splitTextToSizeSafe(pdf, `${prefix}${item}`, wrapW);
      h += lines.length * bulletLineH;
      if (i < items.length - 1) h += gapBetweenBullets;
    });
    return h + boxPadX;
  };

  const hStrength = measureColumn(strengths, '✓ ');
  const hWeak = measureColumn(weaknesses, '• ');
  const boxHeight = Math.max(hStrength, hWeak, 22);

  let boxTop = y;
  const sectionTotalH = 4 + boxHeight + 14;
  if (boxTop + sectionTotalH > bottom) {
    pdf.addPage();
    pdf.setFillColor(...COLORS.primary);
    pdf.rect(0, 0, w, HEADER_H, 'F');
    pdf.setTextColor(...COLORS.white);
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Recommendations & Action Plan', MARGIN, 13);
    boxTop = HEADER_H + 10;
  }

  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...COLORS.grayDark);
  pdf.text('Strengths', MARGIN, boxTop);
  pdf.text('Considerations', MARGIN + colW + 8, boxTop);

  pdf.setFillColor(236, 253, 245);
  drawRoundedRect(pdf, MARGIN, boxTop + 4, colW, boxHeight, 2);
  pdf.setFillColor(254, 243, 242);
  drawRoundedRect(pdf, MARGIN + colW + 8, boxTop + 4, colW, boxHeight, 2);

  /** Body must use normal weight — bold titles above left font state as bold; bold text is wider and overflows wrap. */
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);

  const textLeft = MARGIN + boxPadX;
  const textRight = MARGIN + colW + 8 + boxPadX;

  let sy = boxTop + 4 + boxPadX + 3;
  strengths.forEach((s, si) => {
    const lines = splitTextToSizeSafe(pdf, `✓ ${s}`, wrapW);
    lines.forEach((ln) => {
      pdf.setTextColor(...COLORS.success);
      pdf.text(ln, textLeft, sy);
      sy += bulletLineH;
    });
    if (si < strengths.length - 1) sy += gapBetweenBullets;
  });

  let wy = boxTop + 4 + boxPadX + 3;
  weaknesses.forEach((t, ti) => {
    const lines = splitTextToSizeSafe(pdf, `• ${t}`, wrapW);
    lines.forEach((ln) => {
      pdf.setTextColor(...COLORS.danger);
      pdf.text(ln, textRight, wy);
      wy += bulletLineH;
    });
    if (ti < weaknesses.length - 1) wy += gapBetweenBullets;
  });

  y = boxTop + 4 + boxHeight + 12;
  pdf.setTextColor(...COLORS.grayDark);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Recommended actions', MARGIN, y);
  y += 8;

  const actions = generateActionPlan(score);
  pdf.setFont('helvetica', 'normal');

  actions.forEach((action, i) => {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    const actionLines = splitTextToSizeSafe(pdf, action, w - 2 * MARGIN - 28);
    const rowH = Math.max(12, 8 + actionLines.length * 4);
    if (y + rowH > bottom) {
      pdf.addPage();
      y = HEADER_H + 8;
    }

    pdf.setFillColor(249, 250, 251);
    drawRoundedRect(pdf, MARGIN, y, w - 2 * MARGIN, rowH, 2);

    drawCircleBadge(pdf, i + 1, MARGIN + 10, y + rowH / 2, 4, COLORS.primary, COLORS.white);

    pdf.setTextColor(...COLORS.grayDark);
    pdf.setFontSize(8);
    let ax = y + 6;
    actionLines.forEach((ln) => {
      pdf.text(ln, MARGIN + 22, ax);
      ax += 4;
    });
    y += rowH + 3;
  });

  if (suggestions && suggestions.length > 0) {
    y += 6;
    if (y > bottom - 40) {
      pdf.addPage();
      y = HEADER_H + 8;
    }

    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(...COLORS.grayDark);
    pdf.text('Higher-scoring nearby options', MARGIN, y);
    y += 8;
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(...COLORS.gray);
    const hintLines = splitTextToSizeSafe(
      pdf,
      'Within search radius; tap a suggestion in the app to explore.',
      w - 2 * MARGIN
    );
    hintLines.forEach((ln, i) => {
      pdf.text(ln, MARGIN, y + i * 4);
    });
    y += 4 + hintLines.length * 4;

    suggestions.slice(0, 3).forEach((sugg) => {
      const name =
        sugg.displayName?.split(',').slice(0, 2).join(',') ||
        `${fmtCoord(sugg.lat)}, ${fmtCoord(sugg.lng)}`;
      const line = `${name} · ${fmtDistance(sugg.distance)} mi`;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      const nameLines = splitTextToSizeSafe(pdf, line, w - 2 * MARGIN - 36);
      const rowH = Math.max(14, 8 + nameLines.length * 4);
      if (y + rowH > bottom) {
        pdf.addPage();
        y = HEADER_H + 8;
      }

      pdf.setFillColor(249, 250, 251);
      drawRoundedRect(pdf, MARGIN, y, w - 2 * MARGIN, rowH, 2);

      const sc = Math.round(Number(sugg.score) || 0);
      drawCircleBadge(pdf, fmtScore(sc), MARGIN + 12, y + rowH / 2, 5, getScoreColor(sc), COLORS.white);

      pdf.setTextColor(...COLORS.grayDark);
      pdf.setFontSize(8);
      let ny = y + 8;
      nameLines.forEach((nl) => {
        pdf.text(nl, MARGIN + 24, ny);
        ny += 4;
      });
      y += rowH + 3;
    });
  }

  const totalPages = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    addPageFooter(pdf, i, totalPages);
  }

  return pdf;
}

function generateInsights(score, enabledFactors, analysisResult) {
  const insights = [];
  const factorScores = {};
  enabledFactors.forEach(([key]) => {
    factorScores[key] = Math.round(Number(analysisResult.factorScores[key]) || 0);
  });

  if (score >= 75) {
    insights.push('Strong performance across multiple metrics.');
    insights.push('Favorable demographic indicators for site selection.');
  } else if (score >= 60) {
    insights.push('Solid fundamentals with room to optimize positioning.');
    insights.push('Prioritize marketing toward stronger segments.');
  } else {
    insights.push('Some metrics may need mitigation or validation.');
    insights.push('Compare with alternatives before committing.');
  }

  Object.entries(factorScores).forEach(([key, fScore]) => {
    if (fScore >= 80) insights.push(`${key} is a notable strength.`);
    else if (fScore < 40) insights.push(`${key} may need a targeted plan.`);
  });

  return insights.slice(0, 5);
}

function getOverallAssessment(sc) {
  if (sc >= 75) return 'Strong candidate: metrics align well with typical franchise success factors.';
  if (sc >= 60) return 'Reasonable candidate: validate weak areas against your model before deciding.';
  if (sc >= 40) return 'Mixed profile: weigh trade-offs carefully.';
  return 'Challenging profile: consider alternatives unless you have offsets.';
}

function analyzeStrengthsWeaknesses(enabledFactors, analysisResult) {
  const strengths = [];
  const weaknesses = [];

  enabledFactors.forEach(([key]) => {
    const sc = Math.round(Number(analysisResult.factorScores[key]) || 0);
    const rawValue = fmtRawValue(analysisResult.raw_values[key]?.raw_value);
    if (sc >= 70) strengths.push(`Strong ${key.toLowerCase()} (${rawValue})`);
    else if (sc < 50) weaknesses.push(`Lower ${key.toLowerCase()}`);
  });

  if (strengths.length === 0) strengths.push('No standout strengths');
  if (weaknesses.length === 0) weaknesses.push('No major red flags');

  return { strengths: strengths.slice(0, 4), weaknesses: weaknesses.slice(0, 4) };
}

function generateActionPlan(score) {
  if (score >= 75) {
    return [
      'Site visit to validate assumptions',
      'Competitive scan within radius',
      'Initial lease or purchase discussion',
      'Local marketing outline',
      'Zoning and permit checklist'
    ];
  }
  if (score >= 60) {
    return [
      'Compare 2–3 nearby alternatives',
      'Deep dive on weakest factors',
      'Decide if weak factors matter for your concept',
      'Mitigation ideas for gaps',
      'Traffic and demographic spot-check'
    ];
  }
  return [
    'Prioritize alternative locations',
    'Mitigation plan if you stay',
    'Benchmark competitors in similar score bands',
    'Adjust model or offering if needed',
    'Re-run analysis after changes'
  ];
}
