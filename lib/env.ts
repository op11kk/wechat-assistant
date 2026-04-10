function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

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

export function hasWechatMediaConfig(): boolean {
  return Boolean(env.WECHAT_APP_ID && env.WECHAT_APP_SECRET);
}

export function getR2Endpoint(): string {
  if (!env.CLOUDFLARE_R2_ACCOUNT_ID) {
    throw new Error("Missing CLOUDFLARE_R2_ACCOUNT_ID");
  }
  return `https://${env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
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
  if (!env.CLOUDFLARE_R2_PUBLIC_BASE_URL) {
    return null;
  }
  const base = env.CLOUDFLARE_R2_PUBLIC_BASE_URL.endsWith("/")
    ? env.CLOUDFLARE_R2_PUBLIC_BASE_URL
    : `${env.CLOUDFLARE_R2_PUBLIC_BASE_URL}/`;
  return new URL(objectKey, base).toString();
}
