import { createClient } from "@supabase/supabase-js";

const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

/** True when both vars are present at build time (Vite inlines them). */
export const isSupabaseConfigured = url.length > 0 && anonKey.length > 0;

if (!isSupabaseConfigured) {
  console.warn(
    "[FranchiseFit] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — ACS RPC calls are disabled until set.",
  );
}

/**
 * Browser client (anon key), or null if env vars were missing at build time.
 * Avoid calling createClient("") — @supabase/supabase-js throws "supabaseUrl is required".
 */
export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;
