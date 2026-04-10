import { env, getSupabaseProjectRef } from "@/lib/env";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  const payload: Record<string, unknown> = {
    status: env.SUPABASE_URL && env.SUPABASE_KEY ? "ok" : "misconfigured",
    db: "supabase",
    storage: "cloudflare_r2",
  };
  const ref = getSupabaseProjectRef();
  if (ref) {
    payload.supabase_ref = ref;
  }
  return jsonResponse(payload);
}
