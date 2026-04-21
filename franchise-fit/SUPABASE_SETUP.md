# Supabase Setup Guide for FranchiseFit

This guide will help you migrate from local CSV files to Supabase for production deployment.

## 📋 Prerequisites

1. Create a Supabase account at [supabase.com](https://supabase.com)
2. Create a new Supabase project

## 🗄️ Step 1: Create Database Tables

1. Go to **SQL Editor** in your Supabase dashboard
2. Run the migration file: `supabase/migrations/001_tables.sql`
3. Run the RPC functions file: `supabase/migrations/002_rpc_functions.sql`

This creates 4 tables:
- `national_tract_stats` - National statistics for z-scoring
- `tract_metrics` - Current year tract data with scores
- `county_acs_year` - County ACS data by year
- `tract_acs_year` - Tract ACS history by year

## 📤 Step 2: Upload CSV Data

### Method A: Supabase Table Editor (Recommended)

1. Go to **Table Editor** in Supabase dashboard
2. Select each table and click **Insert → Import data from CSV**
3. Upload the corresponding CSV files:

| Table | CSV File | Rows | Description |
|-------|----------|------|-------------|
| `county_acs_year` | `supabase/csv/county_acs_year.csv` | ~15,720 | County metrics 2020-2024 |
| `tract_acs_year` | `src/data/tractAcsHistory.csv` | ~422,000 | Tract history 2020-2024 |

### Method B: psql Command Line

```bash
# Connect to your Supabase database
psql "postgresql://postgres:[YOUR-PASSWORD]@[YOUR-PROJECT-REF].supabase.co:5432/postgres"

# Import county data
\copy public.county_acs_year FROM 'supabase/csv/county_acs_year.csv' WITH (FORMAT csv, HEADER true);

# Import tract history
\copy public.tract_acs_year FROM 'src/data/tractAcsHistory.csv' WITH (FORMAT csv, HEADER true);
```

## 🔑 Step 3: Configure Environment Variables

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Add your Supabase credentials to `.env`:
```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**⚠️ CRITICAL:** Supabase now has two types of API keys:
- **New publishable keys** (`sb_publishable_...`) - ❌ These do NOT work with RPC functions
- **Legacy anon keys** (`eyJ...`) - ✅ Use this one!

To find your **legacy anon key**:
1. Go to **Supabase Dashboard → Settings → API**
2. Scroll down to **"Legacy anon, service_role API keys"** section
3. Copy the `anon` key (it's a JWT token starting with `eyJ`)

## ✅ Step 4: Verify Setup

1. Start the dev server:
```bash
npm run dev
```

2. Check the browser console (F12 → Console). You should see:
```
[Supabase] Tract ACS history will be loaded on-demand (not preloaded)
```

3. Test the app:
   - Search for a location (e.g., "Miami, FL")
   - Click "Analyze" 
   - Should load **fast** (only queries ~50-200 tracts in the area)
   - Check that tract heatmap loads with colors
   - Click on a tract to see history chart (loads 5 rows on-demand)

## 🚀 Performance

**Supabase mode** (production):
- **Initial load**: ~0 rows (nothing preloaded)
- **Analysis**: ~50-200 tracts + 1 county (on-demand)
- **Tract click**: 5 rows per tract (on-demand)
- **Load time**: < 1 second

**CSV mode** (offline/development):
- **Initial load**: ~422,000 rows (loads full CSV file)
- **Load time**: 30-60 seconds (only first load)

With Supabase, the app loads **instantly** because it only queries the specific data you need!

## 🔄 Fallback Behavior

The app automatically falls back to local CSV files if Supabase is not configured:
- **Supabase configured**: Uses Supabase RPCs (fast, scalable)
- **No Supabase**: Uses local CSV files (works offline, slower)

## 📊 Database Indexes

The migration already creates these indexes for performance:
- `idx_tract_metrics_state` - Spatial queries by state
- `idx_tract_metrics_lat` / `idx_tract_metrics_lng` - Coordinate lookups
- `idx_county_acs_year_fips` - County lookups
- `idx_tract_acs_year_geoid` - Tract history queries

## 🔒 Security

- Tables use Row Level Security (RLS) with public read access
- RPC functions use `SECURITY DEFINER` to bypass RLS
- Anonymous users can only read data, not modify

## 🚀 Optional: tract_metrics Table

For faster queries, you can also populate `tract_metrics` with current year data:

**CSV File:** `supabase/csv/tract_metrics.csv` (~84k rows)

This table includes:
- Current year raw metrics
- Precomputed z-scores (0-100)
- Tract centroids for spatial queries

## 🐛 Troubleshooting

### "RPC function not found"
- Make sure you ran `002_rpc_functions.sql` in SQL Editor
- Check function names match exactly (case-sensitive)

### "Failed to load data"
- Check environment variables are set correctly
- Verify CSV uploads completed successfully
- Check browser console for detailed error messages

### Large CSV Upload Fails
- Use psql method instead of Table Editor for files >100MB
- Split large files if necessary

## 📈 Performance Tips

1. **Batch Queries**: The RPC functions support batch operations
2. **Caching**: Data is cached in memory after first load
3. **Indexes**: All lookups use database indexes
4. **CDN**: Supabase serves data from global CDN

---

**Next Steps:**
- Test thoroughly in development
- Deploy to production with environment variables
- Monitor database usage in Supabase dashboard
