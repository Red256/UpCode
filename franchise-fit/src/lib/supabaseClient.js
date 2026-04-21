import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    "[FranchiseFit] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — database calls will fail until set."
  );
}

/** Browser client (anon key). All heavy logic should live in SECURITY DEFINER RPCs, not exposed tables. */
export const supabase = createClient(url ?? "", anonKey ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});
