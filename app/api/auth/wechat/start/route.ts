import { NextRequest, NextResponse } from "next/server";

import {
  buildWechatAuthorizeUrl,
  createWechatAuthState,
  isWechatAuthMockEnabled,
} from "@/lib/wechat-oauth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const state = createWechatAuthState({
    teamCode: url.searchParams.get("team_code"),
    next: url.searchParams.get("next"),
  });

  if (isWechatAuthMockEnabled()) {
    const callbackUrl = new URL("/api/auth/wechat/callback", request.url);
    callbackUrl.searchParams.set("state", state);
    callbackUrl.searchParams.set("mock_openid", url.searchParams.get("mock_openid") || "mock_openid_default");
    return NextResponse.redirect(callbackUrl);
  }

  return NextResponse.redirect(buildWechatAuthorizeUrl(request, state));
}
