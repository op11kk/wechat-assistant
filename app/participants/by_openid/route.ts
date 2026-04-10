import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { findParticipantByOpenId } from "@/lib/video-submissions";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { searchParams } = new URL(request.url);
  const wechatOpenid = searchParams.get("wechat_openid")?.trim() ?? "";
  if (!wechatOpenid) {
    return jsonResponse({ error: "wechat_openid query param required" }, 400);
  }
  try {
    const participant = await findParticipantByOpenId(wechatOpenid);
    if (!participant) {
      return jsonResponse({ error: "not found", hint: wechatOpenid }, 404);
    }
    return jsonResponse({ participant });
  } catch (error) {
    return jsonResponse({ error: "Query failed", detail: String(error) }, 500);
  }
}
