import {
  env,
  getObjectStorageProvider,
  hasDatabaseConfig,
  hasWechatMediaConfig,
} from "@/lib/env";
import { dbQuery } from "@/lib/db";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  const storageProvider = getObjectStorageProvider();
  const databaseConfigured = hasDatabaseConfig();
  let databaseReachable = false;
  let databaseError: string | null = null;

  if (databaseConfigured) {
    try {
      await dbQuery("select 1 as ok");
      databaseReachable = true;
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
      console.error("[health] database check failed", databaseError);
    }
  }

  const publicBaseOk = Boolean(process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL || process.env.COS_PUBLIC_BASE_URL);
  const payload: Record<string, unknown> = {
    status: databaseReachable ? "ok" : "misconfigured",
    db: "postgres",
    storage: storageProvider ?? "unconfigured",
    checks: {
      database_configured: databaseConfigured,
      database_reachable: databaseReachable,
      api_secret_set: Boolean(env.API_SECRET),
      wechat_token_set: Boolean(env.WECHAT_TOKEN),
      wechat_app_credentials_set: hasWechatMediaConfig(),
      object_storage: storageProvider,
      public_object_base_url_set: publicBaseOk,
      database_error: databaseError,
    },
  };
  return jsonResponse(payload);
}
