import { after, NextRequest } from "next/server";

import { env } from "@/lib/env";
import { jsonResponse, textResponse, xmlResponse } from "@/lib/http";
import {
  createChatVideoWechatSubmission,
  findParticipantByOpenId,
  syncWechatMediaToR2,
} from "@/lib/video-submissions";
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

function getRequestOrigin(request: NextRequest): string {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
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
    signaturePreview: params.signature ? `${params.signature.slice(0, 12)}...` : null,
    ...extra,
  });
}

function isHelpTextKeyword(raw: string | null | undefined): boolean {
  const normalized = raw?.trim().toLowerCase() ?? "";
  return (
    normalized === "openid" ||
    normalized === "帮助" ||
    normalized === "help" ||
    normalized === "上传码" ||
    normalized === "code" ||
    normalized === "?"
  );
}

function isOpenIdHintEvent(msgType: string, event: string | null | undefined): boolean {
  if (msgType !== "event") {
    return false;
  }
  const normalized = event?.trim().toLowerCase() ?? "";
  return normalized === "subscribe" || normalized === "scan";
}

async function buildUploadCodeReplyContent(userOpenid: string, h5Url: string): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);

  if (participant) {
    return [
      `你的上传码：${participant.participant_code}`,
      "",
      `当前状态：${participant.status}`,
      "打开下面的 H5 页面，输入这 6 位上传码即可上传视频：",
      h5Url,
      "",
      "这个上传码比微信 openid 更短，专门给 H5 页面填写。",
    ].join("\n");
  }

  return [
    "你当前还没有上传码。",
    "请先联系管理员登记，登记完成后再向公众号发送“上传码”获取 6 位上传码。",
    "",
    `管理员如需核对你的微信身份，可使用这个 openid：${userOpenid}`,
  ].join("\n");
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
    return jsonResponse(
      {
        error: "Missing query params",
        detail: "微信公众号 URL 校验必须同时携带 signature、timestamp、nonce、echostr。",
        missing,
      },
      400,
    );
  }

  const signatureOk = verifyWechatSignature(signature, timestamp, nonce);
  if (!signatureOk) {
    console.warn("[wechat] GET signature mismatch", wechatSignatureDebug(signature, timestamp, nonce));
    return textResponse("Forbidden", 403);
  }

  return textResponse(echostr.trim());
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
    return jsonResponse(
      {
        error: "Missing query params",
        detail: "微信公众号回调必须携带 signature、timestamp、nonce。",
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
  if (!xml.trim()) {
    return textResponse("success");
  }

  const inbound = parseWechatInboundXml(xml);
  const userOpenid = inbound.openid;
  const officialId = inbound.toUserName;

  const wantsUploadCodeHint =
    userOpenid &&
    officialId &&
    (isOpenIdHintEvent(inbound.msgType, inbound.event) ||
      (inbound.msgType === "text" && isHelpTextKeyword(inbound.content)));

  if (wantsUploadCodeHint && userOpenid && officialId) {
    const h5Url = new URL("/h5", getRequestOrigin(request)).toString();
    const content = await buildUploadCodeReplyContent(userOpenid, h5Url);
    return xmlResponse(
      buildWechatPassiveTextReply({
        toUserOpenid: userOpenid,
        fromOfficialUserName: officialId,
        content,
      }),
    );
  }

  if ((inbound.msgType === "video" || inbound.msgType === "shortvideo") && userOpenid && inbound.mediaId) {
    try {
      const result = await createChatVideoWechatSubmission({
        openid: userOpenid,
        mediaId: inbound.mediaId,
        userComment: inbound.description,
      });

      if (result.ok) {
        after(async () => {
          try {
            await syncWechatMediaToR2(result.submissionId, inbound.mediaId!, result.participantCode);
          } catch (error) {
            console.error("[wechat] async media sync error", error);
          }
        });

        if (officialId) {
          return xmlResponse(
            buildWechatPassiveTextReply({
              toUserOpenid: userOpenid,
              fromOfficialUserName: officialId,
              content: "视频已收到，系统正在拉取素材并归档，请稍候查看。",
            }),
          );
        }

        return textResponse("success");
      }

      if (result.reason === "duplicate") {
        return textResponse("success");
      }

      if (officialId) {
        const content =
          result.reason === "not_registered"
            ? "你还没有上传码，请先联系管理员登记。登记完成后发送“上传码”即可获取 6 位上传码。"
            : result.reason === "participant_inactive"
              ? "你的登记状态当前不是 active，暂时无法收录视频，请联系管理员。"
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

  return textResponse("success");
}
