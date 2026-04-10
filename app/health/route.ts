import {
  env,
  getObjectStorageProvider,
  getSupabaseProjectRef,
  hasWechatMediaConfig,
} from "@/lib/env";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  const storageProvider = getObjectStorageProvider();
  const supabaseOk = Boolean(env.SUPABASE_URL && env.SUPABASE_KEY);
  const publicBaseOk = Boolean(env.CLOUDFLARE_R2_PUBLIC_BASE_URL || env.COS_PUBLIC_BASE_URL);
  const payload: Record<string, unknown> = {
    status: supabaseOk ? "ok" : "misconfigured",
    db: "supabase",
    storage: storageProvider ?? "unconfigured",
    checks: {
      supabase_configured: supabaseOk,
      api_secret_set: Boolean(env.API_SECRET),
      wechat_token_set: Boolean(env.WECHAT_TOKEN),
      wechat_app_credentials_set: hasWechatMediaConfig(),
      object_storage: storageProvider,
      public_object_base_url_set: publicBaseOk,
    },
  };
  const ref = getSupabaseProjectRef();
  if (ref) {
    payload.supabase_ref = ref;
  }
  return jsonResponse(payload);
}
