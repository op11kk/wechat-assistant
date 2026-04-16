import { after, NextRequest } from "next/server";

import { env, hasWechatIngestApiConfig } from "@/lib/env";
import { jsonResponse, textResponse, xmlResponse } from "@/lib/http";
import { dispatchWechatMediaWorker, ingestChatVideoWechat, ingestChatVideoWechatViaApi } from "@/lib/video-submissions";
import {
  buildWechatPassiveTextReply,
  parseWechatInboundXml,
  verifyWechatSignature,
  wechatSignatureDebug,
} from "@/lib/wechat";

export const runtime = "nodejs";

function getWechatSignatureParams(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  return {
    signature: searchParams.get("signature")?.trim() ?? "",
    timestamp: searchParams.get("timestamp")?.trim() ?? "",
    nonce: searchParams.get("nonce")?.trim() ?? "",
    echostr: searchParams.get("echostr")?.trim() ?? "",
  };
}

function logWechatRequest(
  phase: string,
  request: NextRequest,
  params: ReturnType<typeof getWechatSignatureParams>,
  extra?: Record<string, unknown>,
) {
  const url = new URL(request.url);
  console.info("[wechat]", {
    phase,
    method: request.method,
    pathname: url.pathname,
    hasSignature: Boolean(params.signature),
    hasTimestamp: Boolean(params.timestamp),
    hasNonce: Boolean(params.nonce),
    hasEchostr: Boolean(params.echostr?.trim()),
    signaturePreview: params.signature ? `${params.signature.slice(0, 12)}…` : null,
    ...extra,
  });
}

function isHelpTextKeyword(raw: string | null | undefined): boolean {
  const s = raw?.trim().toLowerCase() ?? "";
  return s === "openid" || s === "帮助" || s === "help" || s === "?" || s === "？";
}

function isOpenIdHintEvent(msgType: string, event: string | null | undefined): boolean {
  if (msgType !== "event") {
    return false;
  }
  const normalized = event?.trim().toLowerCase() ?? "";
  return normalized === "subscribe" || normalized === "scan";
}

function openIdRegistrationTip(userOpenid: string): string {
  return `登记用 OpenID：\n${userOpenid}\n\n请将 OpenID、真实姓名、手机号交给管理员调用 POST /participants 录入；录入后再向本号发送视频或小视频即可收录。\n\n也可使用网站上的「大视频上传」页（H5 直传，需对象存储配置）。`;
}

async function ingestVideoAfterReply(params: {
  openid: string;
  mediaId: string;
  userComment?: string | null;
}) {
  const result = hasWechatIngestApiConfig()
    ? await ingestChatVideoWechatViaApi(params)
    : await ingestChatVideoWechat(params);

  console.info("[wechat] async video ingest result", result);
  if (!result.ok || !hasWechatIngestApiConfig()) {
    return;
  }
  await dispatchWechatMediaWorker({
    submissionId: result.submissionId,
    mediaId: params.mediaId,
    participantCode: result.participantCode,
  });
}

export async function GET(request: NextRequest) {
  if (!env.WECHAT_TOKEN) {
    console.error("[wechat] GET missing WECHAT_TOKEN");
    return jsonResponse({ error: "WECHAT_TOKEN not configured" }, 503);
  }
  const { signature, timestamp, nonce, echostr } = getWechatSignatureParams(request);
  logWechatRequest("get_received", request, { signature, timestamp, nonce, echostr });
  const missing: string[] = [];
  if (!signature) {
    missing.push("signature");
  }
  if (!timestamp) {
    missing.push("timestamp");
  }
  if (!nonce) {
    missing.push("nonce");
  }
  if (!echostr.trim()) {
    missing.push("echostr");
  }
  if (missing.length > 0) {
    console.warn("[wechat] GET missing query params (browser direct open is expected)", {
      missing,
      hint: "WeChat sends GET /api/wechat?signature&timestamp&nonce&echostr for URL verification.",
    });
    return jsonResponse(
      {
        error: "Missing query params",
        detail:
          "微信公众平台 URL 校验需要同时提供 signature、timestamp、nonce、echostr。浏览器直接打开本地址不会带这些参数，返回 400 属正常；请用后台「提交」或由脚本模拟请求。",
        missing,
      },
      400,
    );
  }
  const echostrTrimmed = echostr.trim();
  console.info("[wechat] GET query preview", {
    signaturePrefix: `${signature.slice(0, 8)}…`,
    timestamp,
    nonce,
    echostrLength: echostrTrimmed.length,
  });
  const signatureOk = verifyWechatSignature(signature, timestamp, nonce);
  if (!signatureOk) {
    console.warn("[wechat] GET signature mismatch", wechatSignatureDebug(signature, timestamp, nonce));
    return textResponse("Forbidden", 403);
  }
  console.info("[wechat] GET signature verified, returning echostr");
  return textResponse(echostrTrimmed);
}

export async function POST(request: NextRequest) {
  if (!env.WECHAT_TOKEN) {
    console.error("[wechat] POST missing WECHAT_TOKEN");
    return jsonResponse({ error: "WECHAT_TOKEN not configured" }, 503);
  }
  const params = getWechatSignatureParams(request);
  const { signature, timestamp, nonce } = params;
  logWechatRequest("post_received", request, params, {
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
  });
  if (!signature || !timestamp || !nonce) {
    console.warn("[wechat] POST missing required query params");
    return jsonResponse(
      {
        error: "Missing query params",
        detail: "signature, timestamp, nonce are required for WeChat callbacks.",
      },
      400,
    );
  }
  const signatureOk = verifyWechatSignature(signature, timestamp, nonce);
  if (!signatureOk) {
    console.warn("[wechat] POST signature mismatch", wechatSignatureDebug(signature, timestamp, nonce));
    return textResponse("Forbidden", 403);
  }
  const xml = await request.text();
  console.info("[wechat] POST body received", { bodyLength: xml.length });
  if (!xml.trim()) {
    console.warn("[wechat] POST empty body");
    return textResponse("success");
  }
  const inbound = parseWechatInboundXml(xml);
  const userOpenid = inbound.openid;
  const officialId = inbound.toUserName;
  console.info("[wechat] POST parsed inbound", {
    msgType: inbound.msgType,
    event: inbound.event,
    eventKey: inbound.eventKey,
    contentPreview: inbound.content?.slice(0, 32) ?? null,
    hasOpenid: Boolean(userOpenid),
    hasOfficialId: Boolean(officialId),
    hasMediaId: Boolean(inbound.mediaId),
  });
  const wantsOpenidHint =
    userOpenid &&
    officialId &&
    (isOpenIdHintEvent(inbound.msgType, inbound.event) ||
      (inbound.msgType === "text" && isHelpTextKeyword(inbound.content)));
  if (wantsOpenidHint && userOpenid && officialId) {
    console.info("[wechat] POST replying with openid hint", {
      reason:
        inbound.msgType === "text"
          ? "help_keyword"
          : (inbound.event?.trim().toLowerCase() ?? "event"),
      eventKey: inbound.eventKey,
    });
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
      if (hasWechatIngestApiConfig()) {
        after(async () => {
          try {
            await ingestVideoAfterReply({
              openid: userOpenid,
              mediaId: inbound.mediaId!,
              userComment: inbound.description,
            });
          } catch (error) {
            console.error("[wechat] async video ingest error", error);
          }
        });
        if (officialId) {
          return xmlResponse(
            buildWechatPassiveTextReply({
              toUserOpenid: userOpenid,
              fromOfficialUserName: officialId,
              content: "已收到视频，正在处理，请稍后查看结果。",
            }),
          );
        }
        return textResponse("success");
      }

      const result = await ingestChatVideoWechat({
        openid: userOpenid,
        mediaId: inbound.mediaId,
        userComment: inbound.description,
      });
      console.info("[wechat] POST ingest result", result);
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
      console.error("[wechat] video ingest error", error);
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

  console.info("[wechat] POST default success response");
  return textResponse("success");
}
