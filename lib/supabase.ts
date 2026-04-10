import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assertSupabaseEnv, env } from "@/lib/env";

let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) {
    return client;
  }
  assertSupabaseEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return client;
}
