import { env, getObjectStorageProvider, getSupabaseProjectRef } from "@/lib/env";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  const storageProvider = getObjectStorageProvider();
  const payload: Record<string, unknown> = {
    status: env.SUPABASE_URL && env.SUPABASE_KEY ? "ok" : "misconfigured",
    db: "supabase",
    storage: storageProvider ?? "unconfigured",
  };
  const ref = getSupabaseProjectRef();
  if (ref) {
    payload.supabase_ref = ref;
  }
  return jsonResponse(payload);
}
