import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Service-role client for trusted server contexts only (Server Actions, background
// jobs) — bypasses RLS. Never import this from a Client Component or expose the
// key to the client bundle. Used here because exercise generation writes
// answer_key server-side, which learners have no RLS insert grant for.
export function createServiceRoleClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
