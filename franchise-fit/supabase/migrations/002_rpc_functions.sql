-- Supabase RPC functions for FranchiseFit
-- Run this in Supabase SQL Editor after uploading CSV data

-- ============================================================================
-- Get county ACS data for a specific county and year
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ff_get_county_acs(
  p_county_fips text,
  p_year integer
)
RETURNS TABLE (
  county_name text,
  median_income double precision,
  median_rent double precision,
  median_home_value double precision,
  student_population double precision
)
LANGUAGE sql STABLE
SECURITY DEFINER
AS $$
  SELECT 
    county_name,
    median_income,
    median_rent,
    median_home_value,
    student_population
  FROM public.county_acs_year
  WHERE county_fips = p_county_fips
    AND year = p_year
  LIMIT 1;
$$;

-- ============================================================================
-- Get all years of county ACS data for a specific county
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ff_get_county_acs_history(
  p_county_fips text,
  p_years integer[]
)
RETURNS TABLE (
  year integer,
  county_name text,
  median_income double precision,
  median_rent double precision,
  median_home_value double precision,
  student_population double precision
)
LANGUAGE sql STABLE
SECURITY DEFINER
AS $$
  SELECT 
    year,
    county_name,
    median_income,
    median_rent,
    median_home_value,
    student_population
  FROM public.county_acs_year
  WHERE county_fips = p_county_fips
    AND (p_years IS NULL OR year = ANY(p_years))
  ORDER BY year ASC;
$$;

-- ============================================================================
-- Get tract ACS history for a specific tract
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ff_get_tract_acs_history(
  p_geoid text,
  p_years integer[]
)
RETURNS TABLE (
  year integer,
  income double precision,
  rent double precision,
  home_value double precision,
  student_population double precision
)
LANGUAGE sql STABLE
SECURITY DEFINER
AS $$
  SELECT 
    year,
    income,
    rent,
    home_value,
    student_population
  FROM public.tract_acs_year
  WHERE geoid = p_geoid
    AND (p_years IS NULL OR year = ANY(p_years))
  ORDER BY year ASC;
$$;

-- ============================================================================
-- Batch get tract ACS history for multiple tracts (for projection aggregation)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ff_get_tracts_acs_history_batch(
  p_geoids text[],
  p_years integer[]
)
RETURNS TABLE (
  geoid text,
  year integer,
  income double precision,
  rent double precision,
  home_value double precision,
  student_population double precision
)
LANGUAGE sql STABLE
SECURITY DEFINER
AS $$
  SELECT 
    geoid,
    year,
    income,
    rent,
    home_value,
    student_population
  FROM public.tract_acs_year
  WHERE geoid = ANY(p_geoids)
    AND (p_years IS NULL OR year = ANY(p_years))
  ORDER BY geoid, year ASC;
$$;

-- ============================================================================
-- Get county FIPS from coordinates (geocoding)
-- Uses nearest tract centroid from tract_metrics table
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ff_geocode_to_county(
  p_lat double precision,
  p_lng double precision
)
RETURNS TABLE (
  state_fips text,
  county_fips text
)
LANGUAGE sql STABLE
SECURITY DEFINER
AS $$
  WITH nearest AS (
    SELECT 
      state_fips,
      LEFT(geoid, 5) as county_fips,
      intpt_lat,
      intpt_lng,
      -- Simple distance calculation (good enough for finding nearest)
      ((intpt_lat - p_lat) * (intpt_lat - p_lat)) + 
      ((intpt_lng - p_lng) * (intpt_lng - p_lng)) as dist_sq
    FROM public.tract_metrics
    ORDER BY dist_sq ASC
    LIMIT 1
  )
  SELECT state_fips, county_fips
  FROM nearest;
$$;

-- ============================================================================
-- Grant execute permissions to anon role
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.ff_get_county_acs TO anon;
GRANT EXECUTE ON FUNCTION public.ff_get_county_acs_history TO anon;
GRANT EXECUTE ON FUNCTION public.ff_get_tract_acs_history TO anon;
GRANT EXECUTE ON FUNCTION public.ff_get_tracts_acs_history_batch TO anon;
GRANT EXECUTE ON FUNCTION public.ff_geocode_to_county TO anon;
