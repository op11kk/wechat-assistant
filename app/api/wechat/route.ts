import { after, NextRequest } from "next/server";

import { parseParticipantWorkflowRow } from "@/lib/h5-workflow";
import { jsonResponse, textResponse, xmlResponse } from "@/lib/http";
import {
  createChatVideoWechatSubmission,
  createParticipant,
  findParticipantByOpenId,
  syncWechatMediaToR2,
  updateParticipantExtra,
  updateParticipantWorkflow,
} from "@/lib/video-submissions";
import {
  buildWechatPassiveTextReply,
  parseWechatInboundXml,
  verifyWechatSignature,
  wechatSignatureDebug,
} from "@/lib/wechat";
import { env } from "@/lib/env";

export const runtime = "nodejs";

type FlowStage =
  | "awaiting_first_time_answer"
  | "awaiting_consent"
  | "awaiting_test_start"
  | "test_ready"
  | "formal_ready";

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

function getWechatH5EntryUrl(request: NextRequest): string {
  const configuredUrl = env.WECHAT_H5_ENTRY_URL;
  if (configuredUrl) {
    try {
      return new URL(configuredUrl).toString();
    } catch (error) {
      console.warn("[wechat] invalid WECHAT_H5_ENTRY_URL, fallback to request origin", {
        configuredUrl,
        error,
      });
    }
  }

  return new URL("/h5", getRequestOrigin(request)).toString();
}

function buildH5Link(request: NextRequest, participantCode?: string): string {
  const url = new URL(getWechatH5EntryUrl(request));
  if (participantCode) {
    url.searchParams.set("code", participantCode);
  }
  return url.toString();
}

function buildIphoneBrowserNotice(): string[] {
  return [
    "如果你使用的是 iPhone：",
    '请点击右上角 ... ，选择“在浏览器打开”，并使用 Safari 完成上传。',
    "如果在微信内置浏览器里无法上传，这是已知兼容问题。",
  ];
}

function normalizeUserText(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, "");
}

function isHelpTextKeyword(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return (
    lower === "help" ||
    lower === "openid" ||
    lower === "code" ||
    normalized === "帮助" ||
    normalized === "上传码" ||
    normalized === "上传" ||
    normalized === "代码" ||
    normalized === "?"
  );
}

function isFirstTimeYesKeyword(normalized: string): boolean {
  return normalized === "是";
}

function isFirstTimeNoKeyword(normalized: string): boolean {
  return normalized === "否";
}

function isAgreeKeyword(normalized: string): boolean {
  return normalized === "我同意" || normalized === "同意";
}

function isStartTestKeyword(normalized: string): boolean {
  return normalized === "开始测试";
}

function isStartFormalKeyword(normalized: string): boolean {
  return normalized === "开始";
}

function isOpenIdHintEvent(msgType: string, event: string | null | undefined): boolean {
  if (msgType !== "event") {
    return false;
  }
  const normalized = event?.trim().toLowerCase() ?? "";
  return normalized === "subscribe" || normalized === "scan";
}

function buildWelcomeReply(): string {
  return [
    "欢迎参加视频采集。",
    "",
    "请先确认你是否首次参与：",
    "回复“是”表示首次参与",
    "回复“否”表示老用户继续使用",
  ].join("\n");
}

async function setWechatFlowStage(participantId: number, stage: FlowStage, keyword?: string) {
  await updateParticipantExtra(participantId, {
    wechat_flow_stage: stage,
    wechat_last_keyword: keyword ?? null,
    wechat_flow_updated_at: new Date().toISOString(),
  });
}

async function buildUploadCodeReplyContent(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);

  if (!participant) {
    return [
      "系统里还没有查到你的参与记录。",
      "如果你是首次参与，请回复“是”。",
      "如果你是老用户但记录丢失，请联系管理员处理。",
      "",
      `openid：${userOpenid}`,
    ].join("\n");
  }

  const workflow = parseParticipantWorkflowRow(participant);

  if (!workflow.consent_confirmed) {
    await setWechatFlowStage(participant.id, "awaiting_consent", "上传码");
    return [
      `你的上传码：${participant.participant_code}`,
      "",
      "你还没有完成参与确认。",
      "请回复“我同意”继续。",
    ].join("\n");
  }

  if (workflow.test_status === "not_started" || workflow.test_status === "failed") {
    await setWechatFlowStage(participant.id, "awaiting_test_start", "上传码");
    return [
      `你的上传码：${participant.participant_code}`,
      "",
      "当前阶段：测试阶段。",
      "请回复“开始测试”进入测试视频页面。",
    ].join("\n");
  }

  if (workflow.test_status === "pending") {
    await setWechatFlowStage(participant.id, "test_ready", "上传码");
    return [
      `你的上传码：${participant.participant_code}`,
      "",
      "你的测试视频正在审核中。",
      "当前无需重复打开页面，等待审核结果即可。",
    ].join("\n");
  }

  await setWechatFlowStage(participant.id, "formal_ready", "上传码");
  return [
    `你的上传码：${participant.participant_code}`,
    "",
    "测试已通过，你已进入正式任务阶段。",
    "请回复“开始”获取正式任务入口。",
  ].join("\n");
}

async function handleFirstTimeYes(userOpenid: string, request: NextRequest): Promise<string> {
  console.info("[wechat] handleFirstTimeYes:start", {
    openid: userOpenid,
  });

  const existing = await findParticipantByOpenId(userOpenid);
  console.info("[wechat] handleFirstTimeYes:existing_lookup", {
    openid: userOpenid,
    found: Boolean(existing),
    participantId: existing?.id ?? null,
    participantCode: existing?.participant_code ?? null,
  });

  if (existing) {
    const workflow = parseParticipantWorkflowRow(existing);
    console.info("[wechat] handleFirstTimeYes:existing_workflow", {
      openid: userOpenid,
      participantId: existing.id,
      participantCode: existing.participant_code,
      consentConfirmed: workflow.consent_confirmed,
      testStatus: workflow.test_status,
      formalStatus: workflow.formal_status,
    });
    if (!workflow.consent_confirmed) {
      await setWechatFlowStage(existing.id, "awaiting_consent", "是");
      return [
        `系统已为你生成上传码：${existing.participant_code}`,
        "",
        "这个上传码用于进入 H5 视频上传页面，请妥善保存。",
        "如果你确认继续参与，请回复“我同意”。",
      ].join("\n");
    }

    if (workflow.test_status === "not_started" || workflow.test_status === "failed") {
      await setWechatFlowStage(existing.id, "awaiting_test_start", "是");
      return [
        `你已完成建档，上传码：${existing.participant_code}`,
        "",
        "下一步请回复“开始测试”，进入测试视频页面。",
      ].join("\n");
    }

    if (workflow.test_status === "pending") {
      await setWechatFlowStage(existing.id, "test_ready", "是");
      return [
        `你的上传码：${existing.participant_code}`,
        "",
        "你的测试视频正在审核中，请耐心等待结果。",
        "当前无需重复打开页面，等待审核结果即可。",
      ].join("\n");
    }

    await setWechatFlowStage(existing.id, "formal_ready", "是");
    return [
      `你的上传码：${existing.participant_code}`,
      "",
      "你已经进入正式任务阶段。",
      "请回复“开始”获取正式任务入口。",
    ].join("\n");
  }

  const createResult = await createParticipant({
    wechatOpenid: userOpenid,
    status: "active",
    consentConfirmed: false,
    testStatus: "not_started",
    formalStatus: "not_started",
    extra: {
      wechat_flow_stage: "awaiting_consent",
      wechat_onboarding_source: "wechat_auto",
      wechat_onboarding_created_at: new Date().toISOString(),
    },
  });
  console.info("[wechat] handleFirstTimeYes:create_result", {
    openid: userOpenid,
    status: createResult.status,
    detail: createResult.detail ?? null,
    participantId: createResult.participant?.id ?? null,
    participantCode: createResult.participant?.participant_code ?? null,
  });

  if (createResult.status !== "created" || !createResult.participant) {
    console.error("[wechat] handleFirstTimeYes:create_failed", {
      openid: userOpenid,
      status: createResult.status,
      detail: createResult.detail ?? null,
    });
    return "系统暂时无法为你生成上传码，请稍后再试或联系管理员。";
  }

  return [
    `已为你生成唯一上传码：${createResult.participant.participant_code}`,
    "",
    "用途说明：这个上传码用于进入 H5 视频上传页面，请妥善保存。",
    "参与说明：你需要先提交测试视频，测试视频仅用于审核拍摄质量，不计收益。",
    "",
    "如果你已知晓并同意参与，请回复“我同意”。",
  ].join("\n");
}

async function handleFirstTimeNo(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return [
      "系统里还没有查到你的老用户记录。",
      "如果你其实是首次参与，请回复“是”。",
      "如果确认是老用户，请联系管理员核对账号。",
      "",
      `openid：${userOpenid}`,
    ].join("\n");
  }

  return buildUploadCodeReplyContent(userOpenid, request);
}

async function handleConsent(userOpenid: string): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return "系统里还没有你的参与记录。请先回复“是”开始登记。";
  }

  await updateParticipantWorkflow(participant.id, {
    consent_confirmed: true,
    test_status: participant.test_status ?? "not_started",
    formal_status: participant.formal_status ?? "not_started",
  });
  await setWechatFlowStage(participant.id, "awaiting_test_start", "我同意");

  return [
    "已记录你的参与确认。",
    "",
    "测试视频说明：",
    "1. 测试视频仅用于审核拍摄质量，不计收益。",
    "2. 请按页面要求选择场景后上传。",
    "3. 审核通过后才会进入正式任务。",
    "",
    "如果准备好了，请回复“开始测试”。",
  ].join("\n");
}

async function handleStartTest(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return "系统里还没有你的参与记录。请先回复“是”开始登记。";
  }

  const workflow = parseParticipantWorkflowRow(participant);
  if (!workflow.consent_confirmed) {
    await setWechatFlowStage(participant.id, "awaiting_consent", "开始测试");
    return "你还没有完成参与确认。请先回复“我同意”。";
  }

  await setWechatFlowStage(participant.id, "test_ready", "开始测试");

  return [
    "下面是测试视频上传链接：",
    "",
    "苹果手机用户：请确保复制粘贴链接在浏览器上打开。",
    "【重要】在微信上点击打开将无法上传视频。",
    "",
    "安卓手机用户：可直接点击链接并上传视频。",
    "",
    buildH5Link(request, participant.participant_code),
    `身份验证码：${participant.participant_code}`,
    "（请牢记身份验证码，后面结算将会用到）",
  ].join("\n");
}

async function handleStartFormal(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return "系统里还没有你的参与记录。请先回复“是”开始登记。";
  }

  const workflow = parseParticipantWorkflowRow(participant);
  if (!workflow.consent_confirmed) {
    return "你还没有完成参与确认。请先回复“我同意”。";
  }
  if (workflow.test_status === "not_started" || workflow.test_status === "failed") {
    return "你还没有通过测试阶段，请先回复“开始测试”完成测试视频提交。";
  }
  if (workflow.test_status === "pending") {
    return "你的测试视频还在审核中，审核通过后我会提示你进入正式任务。";
  }

  await setWechatFlowStage(participant.id, "formal_ready", "开始");

  return [
    "你已进入正式任务阶段。",
    "正式任务说明：请按页面要求选择场景并上传正式视频，提交后进入审核流程。",
    "",
    "正式任务入口：",
    buildH5Link(request, participant.participant_code),
    "",
    ...buildIphoneBrowserNotice(),
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

  if (!verifyWechatSignature(signature, timestamp, nonce)) {
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

  if (!verifyWechatSignature(signature, timestamp, nonce)) {
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
  const normalizedText = normalizeUserText(inbound.content);
  console.info("[wechat] inbound_parsed", {
    msgType: inbound.msgType,
    event: inbound.event ?? null,
    openid: userOpenid ?? null,
    officialId: officialId ?? null,
    rawContent: inbound.content ?? null,
    normalizedText: normalizedText || null,
    mediaId: inbound.mediaId ?? null,
  });

  if (!userOpenid || !officialId) {
    return textResponse("success");
  }

  if (isOpenIdHintEvent(inbound.msgType, inbound.event)) {
    return xmlResponse(
      buildWechatPassiveTextReply({
        toUserOpenid: userOpenid,
        fromOfficialUserName: officialId,
        content: buildWelcomeReply(),
      }),
    );
  }

  if (inbound.msgType === "text") {
    let content: string | null = null;

    if (isFirstTimeYesKeyword(normalizedText)) {
      content = await handleFirstTimeYes(userOpenid, request);
    } else if (isFirstTimeNoKeyword(normalizedText)) {
      content = await handleFirstTimeNo(userOpenid, request);
    } else if (isAgreeKeyword(normalizedText)) {
      content = await handleConsent(userOpenid);
    } else if (isStartTestKeyword(normalizedText)) {
      content = await handleStartTest(userOpenid, request);
    } else if (isStartFormalKeyword(normalizedText)) {
      content = await handleStartFormal(userOpenid, request);
    } else if (isHelpTextKeyword(normalizedText)) {
      content = await buildUploadCodeReplyContent(userOpenid, request);
    }

    if (content) {
      return xmlResponse(
        buildWechatPassiveTextReply({
          toUserOpenid: userOpenid,
          fromOfficialUserName: officialId,
          content,
        }),
      );
    }
  }

  if ((inbound.msgType === "video" || inbound.msgType === "shortvideo") && inbound.mediaId) {
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

        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content: "视频已收到，系统正在拉取素材并归档，请稍后查看。",
          }),
        );
      }

      if (result.reason === "duplicate") {
        return textResponse("success");
      }

      const content =
        result.reason === "not_registered"
          ? "你还没有参与记录，请先回复“是”开始登记。"
          : result.reason === "participant_inactive"
            ? "你当前状态不是 active，暂时无法收取视频，请联系管理员。"
            : "视频暂时无法保存，请稍后重试或联系管理员。";

      return xmlResponse(
        buildWechatPassiveTextReply({
          toUserOpenid: userOpenid,
          fromOfficialUserName: officialId,
          content,
        }),
      );
    } catch (error) {
      console.error("[wechat] video ingest error", error);
      return xmlResponse(
        buildWechatPassiveTextReply({
          toUserOpenid: userOpenid,
          fromOfficialUserName: officialId,
          content: "系统繁忙，请稍后再试。",
        }),
      );
    }
  }

  return textResponse("success");
}
