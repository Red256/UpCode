-- FranchiseFit: static ACS-derived tables (import from CSV in Supabase Table Editor).
-- No external API calls at runtime — all data is preloaded.

-- National μ/σ for z-scoring (from scripts/computeNationalTractZStats.mjs).
CREATE TABLE IF NOT EXISTS public.national_tract_stats (
  metric_key text NOT NULL,
  acs_year text NOT NULL,
  mu double precision NOT NULL,
  sigma double precision NOT NULL,
  n bigint NOT NULL,
  PRIMARY KEY (metric_key, acs_year)
);

-- One row per census tract: ACS raw fields + precomputed 0–100 scores (from precomputeAllTractScores.mjs)
-- + centroid (INTPTLAT/INTPTLONG) merged from Census Gazetteer for distance queries.
CREATE TABLE IF NOT EXISTS public.tract_metrics (
  geoid text PRIMARY KEY,
  tract_name text,
  state_fips text NOT NULL,
  intpt_lat double precision NOT NULL,
  intpt_lng double precision NOT NULL,
  income double precision,
  rent double precision,
  home_value double precision,
  student_population double precision,
  population double precision,
  score_income integer,
  score_rent integer,
  score_home_value integer,
  score_student_population integer,
  acs_year text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tract_metrics_state ON public.tract_metrics (state_fips);
CREATE INDEX IF NOT EXISTS idx_tract_metrics_lat ON public.tract_metrics (intpt_lat);
CREATE INDEX IF NOT EXISTS idx_tract_metrics_lng ON public.tract_metrics (intpt_lng);

-- County-level ACS (one row per county per year) — for PDF trends + projections.
-- county_fips = 5 digits (state 2 + county 3), matches left(geoid, 5) for tracts in that county.
CREATE TABLE IF NOT EXISTS public.county_acs_year (
  county_fips text NOT NULL,
  year integer NOT NULL,
  county_name text,
  median_income double precision,
  median_rent double precision,
  median_home_value double precision,
  student_population double precision,
  PRIMARY KEY (county_fips, year)
);

CREATE INDEX IF NOT EXISTS idx_county_acs_year_fips ON public.county_acs_year (county_fips);

-- Optional: tract-level multi-year history (large). If empty, tract detail panel uses single-year snapshot only.
CREATE TABLE IF NOT EXISTS public.tract_acs_year (
  geoid text NOT NULL,
  year integer NOT NULL,
  income double precision,
  rent double precision,
  home_value double precision,
  student_population double precision,
  PRIMARY KEY (geoid, year)
);

CREATE INDEX IF NOT EXISTS idx_tract_acs_year_geoid ON public.tract_acs_year (geoid);

ALTER TABLE public.national_tract_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tract_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.county_acs_year ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tract_acs_year ENABLE ROW LEVEL SECURITY;

CREATE POLICY "national_tract_stats_select" ON public.national_tract_stats FOR SELECT USING (true);
CREATE POLICY "tract_metrics_select" ON public.tract_metrics FOR SELECT USING (true);
CREATE POLICY "county_acs_year_select" ON public.county_acs_year FOR SELECT USING (true);
CREATE POLICY "tract_acs_year_select" ON public.tract_acs_year FOR SELECT USING (true);
