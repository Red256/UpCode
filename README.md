# UpCode

A data-driven platform that evaluates potential franchise locations using demographic, education, and regional indicators within a configurable radius to help businesses make smarter expansion decisions.

Built during the **UpCode internship at theCoderSchool** — an 18-week program where a student team delivered a real client product. The result is **FranchiseFit**, a functioning prototype for identifying high-performing sites for new business locations.

**Live demo:** [https://red256.github.io/PA-UpCode/](https://red256.github.io/PA-UpCode/)

## Features

- **Interactive map** — Search U.S. addresses, drop a pin, and explore the surrounding area with Leaflet.
- **Configurable scoring** — Weight and toggle four census-based factors: median income, median rent, median home value, and student density.
- **Radius analysis** — Score locations within a 3, 5, or 6 mile radius, or draw a custom polygon to define the analysis area.
- **Tract heatmap** — Census tract choropleth colored by overall score or individual factors, with per-tract detail on click.
- **Location recommendations** — After analysis, ranked alternative sites within the same radius using the same scoring pipeline.
- **Trend projection** — Linear trend projection from ACS history (tract- or county-level) to estimate how scores may shift.
- **PDF reports** — Download a location report with map snapshot, factor breakdown, recommendations, and trend charts.

## Scoring

Each factor is normalized to a 0–100 score using national census tract z-statistics. The overall score is a weighted average of enabled factors. Verdict bands:

| Score | Verdict   |
|-------|-----------|
| 85+   | Excellent |
| 75–84 | Strong    |
| 65–74 | Moderate  |
| &lt;65 | Risky     |

Data comes primarily from the **U.S. Census Bureau American Community Survey (ACS)** 5-year estimates, with precomputed tract scores and boundaries bundled for offline performance.

## Tech Stack

| Layer        | Technologies |
|--------------|--------------|
| Frontend     | React 19, Vite 7, Leaflet / react-leaflet |
| Geospatial   | Turf.js (area, intersection, distance, polygons) |
| Charts & PDF | Chart.js, jsPDF, html2canvas |
| Backend (optional) | Supabase (Postgres RPC for ACS queries and heatmap GeoJSON) |
| Deployment   | GitHub Actions → GitHub Pages |

## Project Structure

```
UpCode/
├── franchise-fit/          # Main React application
│   ├── src/
│   │   ├── components/     # Map, score card, factor panel, recommendations, etc.
│   │   ├── data/           # Precomputed tract scores, boundaries, national stats
│   │   ├── hooks/
│   │   └── utils/          # Scoring, census API, geocoding, heatmap, reports
│   └── scripts/            # Data download and precomputation pipelines
└── .github/workflows/      # CI deploy to GitHub Pages
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- npm

### Local development

```bash
cd franchise-fit
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`).

### Environment variables

Create `franchise-fit/.env` for optional Supabase-backed census queries:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Without these variables, the app uses bundled offline tract data and direct Census API calls where applicable. For production deploys, add the same secrets in the repository’s **Settings → Secrets and variables → Actions**.

### Build

```bash
cd franchise-fit
npm run build
npm run preview   # serve the production build locally
```

## Data Pipeline Scripts

Run from `franchise-fit/` when refreshing census or geospatial assets:

| Script | Command | Purpose |
|--------|---------|---------|
| Download all | `npm run download:all` | Places, tract boundaries, ACS history |
| Tract scores | `npm run precompute:tracts` | Precompute per-tract factor scores |
| Heatmap grid | `npm run precompute:heatmap` | National score grid for heatmap |
| National stats | `npm run stats:national` | Z-statistics for normalization |
| Boundaries | `npm run download:boundaries` | Census tract boundary GeoJSON |

## Deployment

Pushes to `main` trigger the GitHub Actions workflow in `.github/workflows/deploy.yml`, which builds `franchise-fit` and publishes to GitHub Pages. Configure **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Contributors

- [@Red256](https://github.com/Red256) — Alvin
- [@samjm2](https://github.com/samjm2) - Jotin
- [@Kenneth-Choothakan](https://github.com/Kenneth-Choothakan) - Kenneth
- [@jacobpanchula](https://github.com/jacobpanchula) - Jacob
- [@likeproblem](https://github.com/likeproblem) - Mikhail
