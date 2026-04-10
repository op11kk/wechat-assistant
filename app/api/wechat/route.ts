import { NextRequest } from "next/server";

import { env } from "@/lib/env";
import { textResponse, jsonResponse } from "@/lib/http";
import { ingestChatVideoWechat } from "@/lib/video-submissions";
import { parseWechatInboundXml, verifyWechatSignature } from "@/lib/wechat";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!env.WECHAT_TOKEN) {
    return jsonResponse({ error: "WECHAT_TOKEN not configured" }, 503);
  }
  const { searchParams } = new URL(request.url);
  const signature = searchParams.get("signature") ?? "";
  const timestamp = searchParams.get("timestamp") ?? "";
  const nonce = searchParams.get("nonce") ?? "";
  const echostr = searchParams.get("echostr") ?? "";
  if (!verifyWechatSignature(signature, timestamp, nonce)) {
    return textResponse("Forbidden", 403);
  }
  return textResponse(echostr);
}

export async function POST(request: NextRequest) {
  const xml = await request.text();
  if (!xml.trim()) {
    return textResponse("success");
  }
  const inbound = parseWechatInboundXml(xml);
  if ((inbound.msgType === "video" || inbound.msgType === "shortvideo") && inbound.openid && inbound.mediaId) {
    await ingestChatVideoWechat({
      openid: inbound.openid,
      mediaId: inbound.mediaId,
      userComment: inbound.description,
    });
  }
  return textResponse("success");
}
