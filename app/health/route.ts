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
  const databaseReachable = databaseConfigured
    ? await dbQuery("select 1 as ok").then(() => true).catch(() => false)
    : false;
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
    },
  };
  return jsonResponse(payload);
}
