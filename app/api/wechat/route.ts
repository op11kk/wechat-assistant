import { NextRequest } from "next/server";

import { env } from "@/lib/env";
import { jsonResponse, textResponse, xmlResponse } from "@/lib/http";
import { ingestChatVideoWechat } from "@/lib/video-submissions";
import { buildWechatPassiveTextReply, parseWechatInboundXml, verifyWechatSignature } from "@/lib/wechat";

export const runtime = "nodejs";

function isHelpTextKeyword(raw: string | null | undefined): boolean {
  const s = raw?.trim().toLowerCase() ?? "";
  return s === "openid" || s === "帮助" || s === "help" || s === "?" || s === "？";
}

function openIdRegistrationTip(userOpenid: string): string {
  return `登记用 OpenID：\n${userOpenid}\n\n请将 OpenID、真实姓名、手机号交给管理员调用 POST /participants 录入；录入后再向本号发送视频或小视频即可收录。\n\n也可使用网站上的「大视频上传」页（H5 直传，需对象存储配置）。`;
}

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
  if (!env.WECHAT_TOKEN) {
    return jsonResponse({ error: "WECHAT_TOKEN not configured" }, 503);
  }
  const { searchParams } = new URL(request.url);
  const signature = searchParams.get("signature") ?? "";
  const timestamp = searchParams.get("timestamp") ?? "";
  const nonce = searchParams.get("nonce") ?? "";
  if (!verifyWechatSignature(signature, timestamp, nonce)) {
    return textResponse("Forbidden", 403);
  }
  const xml = await request.text();
  if (!xml.trim()) {
    return textResponse("success");
  }
  const inbound = parseWechatInboundXml(xml);
  const userOpenid = inbound.openid;
  const officialId = inbound.toUserName;
  const wantsOpenidHint =
    userOpenid &&
    officialId &&
    ((inbound.msgType === "event" && inbound.event?.toLowerCase() === "subscribe") ||
      (inbound.msgType === "text" && isHelpTextKeyword(inbound.content)));
  if (wantsOpenidHint && userOpenid && officialId) {
    return xmlResponse(
      buildWechatPassiveTextReply({
        toUserOpenid: userOpenid,
        fromOfficialUserName: officialId,
        content: openIdRegistrationTip(userOpenid),
      }),
    );
  }

  if ((inbound.msgType === "video" || inbound.msgType === "shortvideo") && userOpenid && inbound.mediaId) {
    try {
      const result = await ingestChatVideoWechat({
        openid: userOpenid,
        mediaId: inbound.mediaId,
        userComment: inbound.description,
      });
      if (result.ok && officialId) {
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content:
              "已收到视频，正在归档。若已在服务器配置云存储与微信 AppSecret，系统将自动拉取视频文件。",
          }),
        );
      }
      if (!result.ok && result.reason === "duplicate") {
        return textResponse("success");
      }
      if (!result.ok && officialId) {
        const content =
          result.reason === "not_registered"
            ? "您尚未登记，无法收录视频。请向本号发送「openid」或「帮助」查看登记说明。"
            : result.reason === "participant_inactive"
              ? "您的登记已暂停或退出，无法收录视频。请联系管理员处理。"
              : "视频暂时无法保存，请稍后重试或联系管理员。";
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content,
          }),
        );
      }
    } catch (error) {
      console.error("wechat video ingest error", error);
      if (officialId) {
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content: "系统繁忙，请稍后再试。",
          }),
        );
      }
    }
  }

  return textResponse("success");
}
