function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export type ObjectStorageProvider = "cloudflare_r2" | "tencent_cos";

export const env = {
  SUPABASE_URL: readEnv("SUPABASE_URL"),
  SUPABASE_KEY: readEnv("SUPABASE_KEY"),
  API_SECRET: readEnv("API_SECRET"),
  WECHAT_TOKEN: readEnv("WECHAT_TOKEN"),
  WECHAT_APP_ID: readEnv("WECHAT_APP_ID"),
  WECHAT_APP_SECRET: readEnv("WECHAT_APP_SECRET"),
  CLOUDFLARE_R2_ACCOUNT_ID: readEnv("CLOUDFLARE_R2_ACCOUNT_ID"),
  CLOUDFLARE_R2_ACCESS_KEY_ID: readEnv("CLOUDFLARE_R2_ACCESS_KEY_ID"),
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: readEnv("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
  CLOUDFLARE_R2_BUCKET: readEnv("CLOUDFLARE_R2_BUCKET"),
  CLOUDFLARE_R2_PUBLIC_BASE_URL: readEnv("CLOUDFLARE_R2_PUBLIC_BASE_URL"),
  COS_SECRET_ID: readEnv("COS_SECRET_ID"),
  COS_SECRET_KEY: readEnv("COS_SECRET_KEY"),
  COS_REGION: readEnv("COS_REGION"),
  COS_BUCKET: readEnv("COS_BUCKET"),
  COS_PUBLIC_BASE_URL: readEnv("COS_PUBLIC_BASE_URL"),
};

export function assertSupabaseEnv(): void {
  if (env.SUPABASE_URL && env.SUPABASE_KEY) {
    return;
  }
  throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
}

export function hasR2Config(): boolean {
  return Boolean(
    env.CLOUDFLARE_R2_ACCOUNT_ID &&
      env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
      env.CLOUDFLARE_R2_SECRET_ACCESS_KEY &&
      env.CLOUDFLARE_R2_BUCKET,
  );
}

export function hasCosConfig(): boolean {
  return Boolean(env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_REGION && env.COS_BUCKET);
}

export function hasObjectStorageConfig(): boolean {
  return hasR2Config() || hasCosConfig();
}

export function hasWechatMediaConfig(): boolean {
  return Boolean(env.WECHAT_APP_ID && env.WECHAT_APP_SECRET);
}

export function getObjectStorageProvider(): ObjectStorageProvider | null {
  if (hasR2Config()) {
    return "cloudflare_r2";
  }
  if (hasCosConfig()) {
    return "tencent_cos";
  }
  return null;
}

export function getR2Endpoint(): string {
  if (!env.CLOUDFLARE_R2_ACCOUNT_ID) {
    throw new Error("Missing CLOUDFLARE_R2_ACCOUNT_ID");
  }
  return `https://${env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

/** 虚拟主机样式（bucket 在子域）。若桶名含「.」或格式异常，浏览器会报 ERR_CERT_COMMON_NAME_INVALID。 */
export function getCosEndpoint(): string {
  if (!env.COS_REGION || !env.COS_BUCKET) {
    throw new Error("Missing COS_REGION or COS_BUCKET");
  }
  return `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com`;
}

/** COS S3 兼容 API 的 path-style 端点，证书 CN 匹配 cos.<region>.myqcloud.com，供预签名与 SDK 使用。 */
export function getCosS3PathStyleEndpoint(): string {
  if (!env.COS_REGION) {
    throw new Error("Missing COS_REGION");
  }
  return `https://cos.${env.COS_REGION}.myqcloud.com`;
}

export function getSupabaseProjectRef(): string | null {
  try {
    const host = new URL(env.SUPABASE_URL).hostname.toLowerCase();
    const suffix = ".supabase.co";
    if (!host.endsWith(suffix)) {
      return null;
    }
    return host.slice(0, -suffix.length) || null;
  } catch {
    return null;
  }
}

export function buildPublicObjectUrl(objectKey: string): string | null {
  const rawBase = env.CLOUDFLARE_R2_PUBLIC_BASE_URL || env.COS_PUBLIC_BASE_URL;
  if (!rawBase) {
    return null;
  }
  const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
  return new URL(objectKey, base).toString();
}
