import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import type { WechatLoginIdentity } from "@/lib/app-auth";
import { env } from "@/lib/env";

type WechatAuthState = {
  teamCode?: string | null;
  next?: string | null;
};

type WechatAccessTokenPayload = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  openid?: string;
  scope?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

const WECHAT_OAUTH_STATE_TTL_MINUTES = 10;

function getWechatAuthSecret(): string {
  return env.APP_SESSION_SECRET || env.API_SECRET || "dev-domestic-session-secret";
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signValue(value: string): string {
  return createHmac("sha256", getWechatAuthSecret()).update(value, "utf8").digest("base64url");
}

function signedJson(payload: Record<string, unknown>): string {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${signValue(encoded)}`;
}

function parseSignedJson(token: string): Record<string, unknown> | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) {
    return null;
  }
  const actual = Buffer.from(signature, "utf8");
  const expected = Buffer.from(signValue(encoded), "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(encoded));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeTeamCode(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").replace(/\D/g, "");
  return /^\d{6}$/.test(value) ? value : null;
}

export function isWechatAuthMockEnabled(): boolean {
  if (env.WECHAT_AUTH_MOCK === "0") {
    return false;
  }
  return env.WECHAT_AUTH_MOCK === "1" || !env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET;
}

export function createWechatAuthState(params: WechatAuthState = {}): string {
  return signedJson({
    team_code: normalizeTeamCode(params.teamCode),
    next: params.next ?? null,
    nonce: randomBytes(8).toString("hex"),
    expires_at: new Date(Date.now() + WECHAT_OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString(),
  });
}

export function parseWechatAuthState(rawState: string | null | undefined): WechatAuthState {
  const payload = rawState ? parseSignedJson(rawState.trim()) : null;
  if (!payload) {
    return {};
  }
  const expiresAt = new Date(String(payload.expires_at ?? ""));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return {};
  }
  return {
    teamCode: normalizeTeamCode(String(payload.team_code ?? "")),
    next: typeof payload.next === "string" ? String(payload.next) : null,
  };
}

export function getWechatCallbackUrl(request: NextRequest): string {
  if (env.WECHAT_AUTH_REDIRECT_URI) {
    return env.WECHAT_AUTH_REDIRECT_URI;
  }
  return new URL("/api/auth/wechat/callback", request.url).toString();
}

export function buildWechatAuthorizeUrl(request: NextRequest, state: string): string {
  const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
  url.searchParams.set("appid", env.WECHAT_APP_ID);
  url.searchParams.set("redirect_uri", getWechatCallbackUrl(request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "snsapi_base");
  url.searchParams.set("state", state);
  return `${url.toString()}#wechat_redirect`;
}

export function buildMockWechatIdentity(openid: string | null | undefined): WechatLoginIdentity {
  const normalizedOpenid = String(openid ?? "").trim() || "mock_openid_default";
  return {
    provider: "wechat",
    appid: env.WECHAT_APP_ID || "mock_wechat_app",
    openid: normalizedOpenid,
    unionid: `mock_unionid_${normalizedOpenid}`,
    nickname: "本地微信测试用户",
    raw: {
      mock: true,
    },
  };
}

export async function exchangeWechatCodeForIdentity(code: string): Promise<WechatLoginIdentity> {
  if (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET) {
    throw new Error("missing_wechat_oauth_config");
  }

  const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  url.searchParams.set("appid", env.WECHAT_APP_ID);
  url.searchParams.set("secret", env.WECHAT_APP_SECRET);
  url.searchParams.set("code", code);
  url.searchParams.set("grant_type", "authorization_code");

  const response = await fetch(url, {
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as WechatAccessTokenPayload | null;
  if (!response.ok || !payload || payload.errcode || !payload.openid) {
    const detail = payload?.errmsg || `HTTP ${response.status}`;
    throw new Error(`wechat_oauth_exchange_failed:${detail}`);
  }

  return {
    provider: "wechat",
    appid: env.WECHAT_APP_ID,
    openid: payload.openid,
    unionid: payload.unionid ?? null,
    raw: payload as Record<string, unknown>,
  };
}
