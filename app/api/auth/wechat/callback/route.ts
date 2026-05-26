import { NextRequest, NextResponse } from "next/server";

import {
  attachAppSessionCookie,
  attachWechatPendingCookie,
  createAppSession,
  createWechatPendingToken,
  findAppUserByWechatIdentity,
  getRoleHomePath,
  mapAuthSetupError,
} from "@/lib/app-auth";
import {
  buildMockWechatIdentity,
  exchangeWechatCodeForIdentity,
  isWechatAuthMockEnabled,
  parseWechatAuthState,
} from "@/lib/wechat-oauth";

export const runtime = "nodejs";

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || null;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const state = parseWechatAuthState(url.searchParams.get("state"));

  try {
    const identity = isWechatAuthMockEnabled()
      ? buildMockWechatIdentity(url.searchParams.get("mock_openid"))
      : await exchangeWechatCodeForIdentity(String(url.searchParams.get("code") ?? ""));

    const user = await findAppUserByWechatIdentity(identity);
    if (user) {
      const session = await createAppSession({
        userId: user.id,
        ipAddress: getClientIp(request),
        userAgent: request.headers.get("user-agent"),
      });
      const response = NextResponse.redirect(new URL(getRoleHomePath(user.role), request.url));
      return attachAppSessionCookie(response, session.token, session.expiresAt);
    }

    const bindUrl = new URL("/wechat-bind", request.url);
    if (state.teamCode) {
      bindUrl.searchParams.set("team_code", state.teamCode);
    }

    const response = NextResponse.redirect(bindUrl);
    return attachWechatPendingCookie(response, createWechatPendingToken(identity));
  } catch (error) {
    const setupError = mapAuthSetupError(error);
    if (setupError) {
      const errorUrl = new URL("/", request.url);
      errorUrl.searchParams.set("auth_error", setupError.error);
      return NextResponse.redirect(errorUrl);
    }
    throw error;
  }
}
