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

/**
 * 腾讯云 COS S3 兼容接口必须使用虚拟主机样式，否则报错 PathStyleDomainForbidden。
 * COS_BUCKET 须与控制台「存储桶名称」完全一致，一般为「自定义前缀-APPID」单段，勿重复拼接两段。
 */
export function getCosEndpoint(): string {
  if (!env.COS_REGION || !env.COS_BUCKET) {
    throw new Error("Missing COS_REGION or COS_BUCKET");
  }
  return `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com`;
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
