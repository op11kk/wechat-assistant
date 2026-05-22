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
  buildWechatPassiveImageReply,
  buildWechatPassiveTextReply as buildRawWechatPassiveTextReply,
  buildWechatPassiveVideoReply,
  parseWechatInboundXml,
  sendWechatCustomTextMessage,
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

const MENU_CODE_KEY = "MENU_CODE";
const MENU_UPLOAD_KEY = "MENU_UPLOAD";
const MENU_GROUP_KEY = "MENU_GROUP";
const MENU_GUIDE_KEY = "MENU_GUIDE";
const MENU_ABOUT_KEY = "MENU_PROJECT_INTRO";
const MENU_PROJECT_KEY = "MENU_PROJECT_INTRO";
const MENU_SAMPLE_KEY = "MENU_SAMPLE_VIDEO";
const MENU_STANDARD_KEY = "MENU_SHOOTING_STANDARD";
const MENU_SETTLEMENT_KEY = "MENU_SETTLEMENT_RULES";
const MENU_CONTACT_KEY = "MENU_CONTACT_SERVICE";
const SAMPLE_VIDEO_TITLE = "样片";
const SAMPLE_VIDEO_DESCRIPTION = "点击查看19秒拍摄样片";
const ACTION_DEDUP_WINDOW_MS = 3_000;
const IDENTITY_CODE_CACHE_WINDOW_MS = 30_000;
const recentWechatActions = new Map<string, number>();
const identityCodeReplyCache = new Map<string, { content: string; timestamp: number }>();
const GROUP_LINK_URL = "https://mp.weixin.qq.com/";
const PROJECT_INTRO_URL = "https://mp.weixin.qq.com/s/kU8HnmvMPWDnVwfxBDQPwA";
const SHOOTING_GUIDE_URL = "https://mp.weixin.qq.com/s/OY0OAR5PYFulOmNuXMvu6g";
const SETTLEMENT_RULES_URL = "https://mp.weixin.qq.com/s/FtzGNFfrS3PUWbo2HAswfA";
const GENERIC_UPLOAD_URL = "https://xxxx.com/upload";
const CUSTOMER_SERVICE_WECHAT = "wxid_qwnuryfrdgw822";

type WechatPassiveReply =
  | { kind: "text"; content: string }
  | { kind: "image"; mediaId: string }
  | { kind: "video"; mediaId: string; title?: string; description?: string };

function renderWechatPassiveReply(params: {
  reply: WechatPassiveReply;
  toUserOpenid: string;
  fromOfficialUserName: string;
}) {
  const { reply, toUserOpenid, fromOfficialUserName } = params;

  if (reply.kind === "image") {
    return xmlResponse(
      buildWechatPassiveImageReply({
        toUserOpenid,
        fromOfficialUserName,
        mediaId: reply.mediaId,
      }),
    );
  }

  if (reply.kind === "video") {
    return xmlResponse(
      buildWechatPassiveVideoReply({
        toUserOpenid,
        fromOfficialUserName,
        mediaId: reply.mediaId,
        title: reply.title,
        description: reply.description,
      }),
    );
  }

  return xmlResponse(
    buildWechatPassiveTextReply({
      toUserOpenid,
      fromOfficialUserName,
      content: reply.content,
    }),
  );
}

const ASYNC_PROCESSING_REPLY = "";

const DUPLICATE_ACTION_REPLY = [
  "⏳ 正在处理中",
  "请勿重复点击或重复发送，系统会继续处理上一条请求。",
].join("\n");

const REVIEW_SETTLEMENT_NOTICE_LINES = [
  "上传完成后，你可以在页面中查看：",
  "- 视频是否上传成功",
  "- 视频当前审核状态",
  "- 视频最终审核结果",
  "【审核与结算说明】",
  "视频提交成功后，我们会在【1–3小时内完成审核】。",
  "审核通过的视频，将进入当日结算流程。",
  "工作人员会主动联系您确认结算方式，并发放对应奖励。",
  "请放心，所有视频都会按照统一标准进行审核。",
  "只要视频符合任务要求并通过审核，就会正常进入结算流程。",
];

const DUPLICATE_ACTION_REPLY_TEXT = [
  "正在处理中。",
  "请勿重复点击或重复发送，系统会继续处理上一条请求。",
].join("\n");

const REVIEW_SETTLEMENT_NOTICE_LINES_V2 = [
  "上传完成后，你可以在页面中查看：",
  "- 视频是否上传成功",
  "- 视频当前审核状态",
  "- 视频最终审核结果",
  "【审核与结算说明】",
  "视频提交成功后，我们一般会在【1–3小时内完成审核】。",
  "审核通过后，工作人员会主动联系您确认结算方式，并发放对应奖励。",
  `具体结算标准与审核规则请查看：${SETTLEMENT_RULES_URL}`,
];

function decorateWechatReplyContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) {
    return content;
  }

  if (/^(?:\u2728|\u2705|\uD83D\uDCE8|\u26A0\uFE0F|【)\s*/.test(normalized)) {
    return content;
  }

  return `\u2728 ${content}`;
}

function buildWechatPassiveTextReply(params: {
  toUserOpenid: string;
  fromOfficialUserName: string;
  content: string;
}) {
  return buildRawWechatPassiveTextReply({
    ...params,
    content: decorateWechatReplyContent(params.content),
  });
}

function buildUnknownCommandReply(): string {
  return [
    "【💬操作提示】",
    "新用户请先回复【我同意】完成授权确认。",
    "完成后点击菜单【获取身份码】查看身份码，再点击【上传】继续。",
    "如果你已经有身份码，直接点击菜单【上传】即可。",
    "如需人工帮助，请回复【人工】。",
  ].join("\n");
}

function pruneRecentWechatActions(now: number) {
  for (const [key, timestamp] of recentWechatActions.entries()) {
    if (now - timestamp > ACTION_DEDUP_WINDOW_MS) {
      recentWechatActions.delete(key);
    }
  }
}

function claimWechatAction(openid: string, action: string): boolean {
  const now = Date.now();
  pruneRecentWechatActions(now);

  const key = `${openid}:${action}`;
  const lastTriggeredAt = recentWechatActions.get(key);
  if (lastTriggeredAt && now - lastTriggeredAt < ACTION_DEDUP_WINDOW_MS) {
    return false;
  }

  recentWechatActions.set(key, now);
  return true;
}

function tryClaimWechatActionReply(openid: string, action: string): string | null {
  return claimWechatAction(openid, action) ? null : DUPLICATE_ACTION_REPLY_TEXT;
}

function pruneIdentityCodeReplyCache(now: number) {
  for (const [openid, entry] of identityCodeReplyCache.entries()) {
    if (now - entry.timestamp > IDENTITY_CODE_CACHE_WINDOW_MS) {
      identityCodeReplyCache.delete(openid);
    }
  }
}

function getCachedIdentityCodeReplyContent(openid: string): string | null {
  const now = Date.now();
  pruneIdentityCodeReplyCache(now);
  const cached = identityCodeReplyCache.get(openid);
  if (!cached) {
    return null;
  }
  if (now - cached.timestamp > IDENTITY_CODE_CACHE_WINDOW_MS) {
    identityCodeReplyCache.delete(openid);
    return null;
  }
  return cached.content;
}

function cacheIdentityCodeReplyContent(openid: string, content: string): string {
  identityCodeReplyCache.set(openid, {
    content,
    timestamp: Date.now(),
  });
  return content;
}

function clearIdentityCodeReplyCache(openid: string) {
  identityCodeReplyCache.delete(openid);
}

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

function hasClaimedIdentityCode(participant: Awaited<ReturnType<typeof findParticipantByOpenId>>): boolean {
  if (!participant) {
    return false;
  }

  const claimed = participant.extra?.wechat_identity_code_claimed;
  return claimed !== false;
}

async function markIdentityCodeClaimed(participantId: number) {
  await updateParticipantExtra(participantId, {
    wechat_identity_code_claimed: true,
    wechat_identity_code_claimed_at: new Date().toISOString(),
  });
}

function normalizeUserText(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, "");
}

function isHelpTextKeyword(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return (
    lower === "help" ||
    normalized === "帮助" ||
    normalized === "上传" ||
    normalized === "?"
  );
}

function isGuideTextKeyword(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return (
    lower === "guide" ||
    normalized === "指引" ||
    normalized === "流程" ||
    normalized === "我该做什么" ||
    normalized === "怎么做"
  );
}

function isIdentityCodeKeyword(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return (
    lower === "openid" ||
    lower === "code" ||
    normalized === "上传码" ||
    normalized === "身份码" ||
    normalized === "代码"
  );
}

function isManualTextKeyword(normalized: string): boolean {
  return normalized === "人工";
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
    "【✨欢迎使用视频素材采集助手】",
    "",
    "这里是视频素材采集小助手，你可以在这里完成参与授权、身份码获取和视频上传。",
    "你提交的视频素材可能会被用于商业用途，包括但不限于：软件开发、商业合作及相关技术服务。",
    "请在参与前确认：",
    "1. 你自愿参与本次视频素材采集；",
    "2. 你提交的视频为本人合法拍摄或你有权授权使用；",
    "3. 你同意我们在合法合规范围内，对你提交的视频素材进行存储、复制、分析、处理、交付及商业化使用；",
    "4. 请勿上传涉及他人隐私、敏感信息、违法违规内容，或未经他人同意的可识别个人信息内容。",
    "如你已阅读并同意以上内容，请回复：",
    "【我同意】",
  ].join("\n");
}

function buildGuideReplyContent(): string {
  return [
    "【📌操作指引】",
    "新用户请先回复【我同意】完成授权确认。",
    "🆔 获取身份码：点击菜单【获取身份码】",
    "📤 上传：点击菜单【上传】",
    "如果你已经有身份码，可直接点击菜单【上传】。",
    "💬 如果需要人工协助，请直接回复【人工】",
  ].join("\n");
}

function buildManualReplyContent(): string {
  return [
    "【👩‍💼人工协助】",
    "请直接发送你遇到的问题，并附上你的身份码。",
    "我们看到消息后会尽快人工跟进处理。",
  ].join("\n");
}

function buildAboutUsReplyContent(): string {
  return [
    "【我们是谁】",
    "我们是一家专注于人形机器人行业的数据服务商，正在为下一代人形机器人提供学习素材。",
    "你录制的每一段居家或办公场景动作视频，例如切菜、搅拌、拿取物品，都将成为训练人形机器人的重要数据。",
    "这些数据将主要用于：",
    "- 空间感知：帮助机器人学习物体的深度信息和视角变化",
    "- 动作逻辑：帮助机器人理解从开始交互到完全放稳的完整动作过程",
    "- 环境适应：帮助机器人识别不同光线、不同背景下的真实世界",
    "【为什么可以信任我们】",
    "- 纯净兼职，零门槛加入：严禁收取任何押金、保证金或入职费",
    "- 报酬清晰：任务单价固定为1元/分钟，审核通过后按任务规则结算",
    "- 结果公开可见：群内公示结算总表，产出和收益真实可查",
  ].join("\n");
}

function buildShootingStandardReplyContent(): string {
  return [
    "【拍摄标准】",
    "1. 场景要求：必须在光线充足的环境下录制，确保被操作物体的细节、纹理清晰可见，严禁背光拍摄。",
    "2. 动作逻辑：必须完整包含“抓取—移动—摆放”的动作闭环，过程需自然连贯，严禁中途断录。",
    "3. 视角规范：采用第一人称视角，双手及完整小臂必须全程保持在画面中心区域。",
    "4. 画面稳定性：建议使用挂脖、头部支架或固定支架，严禁画面剧烈抖动。",
    "5. 时长控制：单个视频时长上限为10分钟，如任务较长请分段上传。",
  ].join("\n");
}

function buildWelcomeReplyV2(): string {
  return [
    "【✨欢迎加入素材采集计划】",
    "",
    "您好，这里是视频素材采集助手。",
    "",
    "我们正在收集真实生活场景中的手部动作、物品操作和日常行为视频，用于机器人训练、具身智能算法研发、AI 模型训练、软件开发及相关商业用途。",
    "",
    "如果您想了解我们是谁、为什么要做这件事、视频素材会如何被使用，可以点击下方链接查看详细介绍：",
    "【了解项目介绍】",
    PROJECT_INTRO_URL,
    "",
    "您可以通过提交符合要求的视频素材参与任务。视频审核通过后，将按照任务规则获得对应奖励。",
    "",
    "【参与流程】",
    "1. 先加入任务社群，查看最新任务：",
    "【加入社群链接】",
    GROUP_LINK_URL,
    "",
    "2. 查看拍摄标准和样片，确认视频怎么拍、什么样的视频可以通过审核：",
    "【拍摄标准及样片】",
    SHOOTING_GUIDE_URL,
    "",
    "3. 阅读下一条【授权提示】，并回复【我同意】完成授权确认。",
    "完成授权后，才可以获取身份码和上传视频。",
    "",
    "4. 点击底部菜单【获取身份码】。",
    "身份码将用于识别您的上传记录、审核状态和结算信息。",
    "",
    "5. 点击底部菜单【上传视频】或进入下方链接上传视频：",
    "【上传视频链接】",
    GENERIC_UPLOAD_URL,
    "",
    "6. 等待审核与结算。",
    "视频提交成功后，我们一般会在【1–3小时内完成审核】。",
    "审核通过后，工作人员会主动联系您确认结算方式，并发放对应奖励。",
    "",
    "具体结算标准与审核规则请查看：",
    "【结算规则】",
    SETTLEMENT_RULES_URL,
    "",
    "7. 如遇到身份码、上传失败、审核状态或结算问题，可联系人工客服：",
    "【联系客服】",
    `客服微信：${CUSTOMER_SERVICE_WECHAT}`,
    "",
    "请继续阅读下一条【授权提示】。如您确认同意，请回复【我同意】。",
  ].join("\n");
}

function buildAuthorizationPromptReplyV2(): string {
  return [
    "【授权提示】",
    "",
    "您提交的视频素材可能会被用于商业用途，包括但不限于：机器人训练、具身智能算法研发、AI 模型训练、软件产品开发、数据处理、数据标注、模型评估、产品测试、商业合作及相关技术服务。",
    "",
    "回复【我同意】即表示您确认：",
    "1. 您自愿参与本次视频素材采集；",
    "2. 您提交的视频为本人合法拍摄，或您有权授权使用；",
    "3. 您同意平台在合法合规范围内，对您提交的视频素材进行存储、复制、分析、处理、标注、训练、研发、展示、交付及商业化使用；",
    "4. 除平台说明的任务奖励或结算规则外，您不再就已提交素材向平台主张额外授权费用；",
    "5. 请勿上传涉及他人隐私、敏感信息、违法违规内容，或未经他人同意的可识别个人信息内容。",
    "",
    "如您已阅读并同意以上内容，请回复：【我同意】",
    "",
    "完成授权确认后，请点击底部菜单【获取身份码】，再点击【上传视频】开始提交素材。",
  ].join("\n");
}

function buildGuideReplyContentV2(): string {
  return [
    "【操作指引】",
    "1. 请先回复【我同意】完成授权确认。",
    "2. 点击菜单【获取身份码】获取专属身份码。",
    "3. 点击菜单【上传视频】提交视频素材。",
    "4. 点击菜单【其他】可查看项目介绍、拍摄标准和结算规则。",
  ].join("\n");
}

function buildManualReplyContentV2(): string {
  return [
    "【人工协助】",
    "请直接发送你遇到的问题，并附上你的身份码。",
    `客服微信：${CUSTOMER_SERVICE_WECHAT}`,
  ].join("\n");
}

function buildJoinGroupReplyContentV2(): string {
  return [
    "【加入社群】",
    "请点击下方链接加入任务社群：",
    GROUP_LINK_URL,
  ].join("\n");
}

function buildProjectIntroReplyContentV2(): string {
  return [
    "【项目介绍】",
    "请点击下方链接查看项目介绍：",
    PROJECT_INTRO_URL,
  ].join("\n");
}

function buildShootingStandardReplyContentV2(): string {
  return [
    "【拍摄标准】",
    "请点击下方链接查看拍摄标准及样片：",
    SHOOTING_GUIDE_URL,
  ].join("\n");
}

function buildSettlementRuleReplyContentV2(): string {
  return [
    "【结算规则】",
    "请点击下方链接查看结算规则：",
    SETTLEMENT_RULES_URL,
  ].join("\n");
}

function buildContactServiceReplyContentV2(): string {
  return [
    "【联系客服】",
    `客服微信：${CUSTOMER_SERVICE_WECHAT}`,
  ].join("\n");
}

function buildConsentRequiredReplyV2(): string {
  return [
    "【请先完成授权确认】",
    "为了确保视频素材采集和使用合规，您需要先完成授权确认，才可以获取身份码和上传视频。",
    "",
    "请在当前公众号对话框回复：",
    "【我同意】",
    "",
    "回复后，即表示您已阅读并同意本次视频素材采集的授权说明。",
    "完成授权确认后，请再点击底部菜单【获取身份码】。",
    "获取身份码后，即可点击【上传视频】提交素材。",
  ].join("\n");
}

function buildConsentCompletedReplyV2(): string {
  return [
    "【✅授权确认完成】",
    "",
    "您已完成视频素材采集授权确认。",
    "",
    "请点击底部菜单：",
    "1. 【获取身份码】",
    "先获取您的专属身份码。",
    "",
    "2. 【上传视频】",
    "获取身份码后，即可提交视频素材。",
    "",
    "请务必保存好您的身份码，后续视频审核、记录查询和结算都会使用该身份码。",
  ].join("\n");
}

function buildWelcomeReplyV3(): string {
  return [
    "【✨欢迎加入素材采集计划】",
    "",
    "您好，这里是视频素材采集助手。",
    "",
    "我们正在收集真实生活场景中的手部动作、物品操作和日常行为视频，用于机器人训练、具身智能算法研发、AI 模型训练、软件开发及相关商业用途。",
    "",
    "如果您想了解我们是谁、为什么要做这件事、视频素材会如何被使用，可以点击下方链接查看详细介绍：",
    "【了解项目介绍】",
    "https://mp.weixin.qq.com/s/kU8HnmvMPWDnVwfxBDQPwA",
    "",
    "您可以通过提交符合要求的视频素材参与任务。视频审核通过后，将按照任务规则获得对应奖励。",
    "",
    "【参与流程】",
    "1. 先点击底部菜单【其他 - 加入社群】，查看最新任务群二维码并加入任务社群。",
    "2. 查看拍摄标准和样片，确认视频怎么拍、什么样的视频可以通过审核：",
    "【拍摄标准及样片】",
    "https://mp.weixin.qq.com/s/OY0OAR5PYFulOmNuXMvu6g",
    "3. 阅读下一条【授权提示】，并回复【我同意】完成授权确认。",
    "完成授权后，才可以获取身份码和上传视频。",
    "4. 点击底部菜单【获取身份码】。",
    "身份码将用于识别您的上传记录、审核状态和结算信息。",
    "5. 点击底部菜单【上传视频】进入您的专属上传页面提交视频。",
    "6. 等待审核与结算。",
    "视频提交成功后，我们一般会在【1–3小时内完成审核】。",
    "审核通过后，工作人员会主动联系您确认结算方式，并发放对应奖励。",
    "具体结算标准与审核规则请查看：",
    "【结算规则】",
    "https://mp.weixin.qq.com/s/FtzGNFfrS3PUWbo2HAswfA",
    "",
    "7. 如遇到身份码、上传失败、审核状态或结算问题，可联系人工客服：",
    "【联系客服】",
    `客服微信：${CUSTOMER_SERVICE_WECHAT}`,
    "",
    "请继续阅读下一条【授权提示】。如您确认同意，请回复【我同意】。",
  ].join("\n");
}

function buildWelcomeReplyV4(): string {
  return [
    "【✨欢迎加入素材采集计划】",
    "您好，这里是视频素材采集助手。",
    "我们正在收集真实生活场景中的手部动作、物品操作和日常行为视频，用于机器人训练、具身智能算法研发、AI 模型训练、软件开发及相关商业用途。",
    "如果您想了解我们是谁、为什么要做这件事、视频素材会如何被使用，可以点击下方链接查看详细介绍：",
    "【了解项目介绍】",
    PROJECT_INTRO_URL,
    "您可以通过提交符合要求的视频素材参与任务。视频审核通过后，将按照任务规则获得对应奖励。",
    "【参与流程】",
    "1. 查看拍摄标准和样片，确认视频怎么拍、什么样的视频可以通过审核：",
    "【拍摄标准及样片】",
    SHOOTING_GUIDE_URL,
    "2. 阅读下一条【授权提示】，并回复【我同意】完成授权确认。",
    "完成授权后，才可以获取身份码和上传视频。",
    "3. 点击底部菜单【获取身份码】。",
    "身份码将用于识别您的上传记录、审核状态和结算信息。",
    "4. 点击底部菜单【上传视频】进入您的专属上传页面提交视频。",
    "5. 等待审核与结算。",
    "视频提交成功后，我们一般会在【1–3小时内完成审核】。",
    "审核通过后，工作人员会主动联系您确认结算方式，并发放对应奖励。",
    "具体结算标准与审核规则请查看：",
    "【结算规则】",
    SETTLEMENT_RULES_URL,
    "请继续阅读下一条【授权提示】。如您确认同意，请回复【我同意】。",
  ].join("\n");
}

function buildAuthorizationPromptReplyV3(): string {
  return [
    "【授权提示】",
    "您提交的视频素材可能会被用于商业用途，包括但不限于：机器人训练、具身智能算法研发、AI 模型训练、软件产品开发、数据处理、数据标注、模型评估、产品测试、商业合作及相关技术服务。",
    "回复【我同意】即表示您确认：",
    "1. 您自愿参与本次视频素材采集；",
    "2. 您提交的视频为本人合法拍摄，或您有权授权使用；",
    "3. 您同意平台在合法合规范围内，对您提交的视频素材进行存储、复制、分析、处理、标注、训练、研发、展示、交付及商业化使用；",
    "4. 除平台说明的任务奖励或结算规则外，您不再就已提交素材向平台主张额外授权费用；",
    "5. 请勿上传涉及他人隐私、敏感信息、违法违规内容，或未经他人同意的可识别个人信息内容。",
    "如您已阅读并同意以上内容，请回复：【我同意】",
    "完成授权确认后，请点击底部菜单【获取身份码】，再点击【上传视频】开始提交素材。",
  ].join("\n");
}

function buildGuideReplyContentV3(): string {
  return [
    "【拍摄标准及样片】",
    "请点击下方链接查看拍摄标准及样片：",
    SHOOTING_GUIDE_URL,
    "",
    "【结算规则】",
    SETTLEMENT_RULES_URL,
  ].join("\n");
}

function buildManualReplyContentV3(): string {
  return [
    "【人工协助】",
    "请直接发送你遇到的问题，并附上你的身份码。",
    `客服微信：${CUSTOMER_SERVICE_WECHAT}`,
  ].join("\n");
}

function buildJoinGroupReplyContentV3(): string {
  return [
    "【加入社群】",
    "请扫描下方二维码加入任务群。",
    "该二维码 7 天内有效，如二维码已过期，请联系人工客服获取最新入群方式。",
  ].join("\n");
}

function buildContactServiceReplyContentV3(): string {
  return [
    "【联系客服】",
    `客服微信：${CUSTOMER_SERVICE_WECHAT}`,
  ].join("\n");
}

function buildConsentRequiredReplyV3(): string {
  return [
    "【请先完成授权确认】",
    "为了确保视频素材采集和使用合规，您需要先完成授权确认，才可以获取身份码和上传视频。",
    "",
    "请在当前公众号对话框回复：",
    "【我同意】",
    "",
    "回复后，即表示您已阅读并同意本次视频素材采集的授权说明。",
    "完成授权确认后，请再点击底部菜单：",
    "【获取身份码】",
    "获取身份码后，即可点击【上传视频】提交素材。",
  ].join("\n");
}

function buildConsentCompletedReplyV3(): string {
  return [
    "【✅授权确认完成】",
    "",
    "您已完成视频素材采集授权确认。",
    "",
    "请点击底部菜单：",
    "1. 【获取身份码】",
    "先获取您的专属身份码。",
    "",
    "2. 【上传视频】",
    "获取身份码后，即可提交视频素材。",
    "",
    "请务必保存好您的身份码，后续视频审核、记录查询和结算都会使用该身份码。",
  ].join("\n");
}

async function handleWechatMenuClickV3(
  eventKey: string | null | undefined,
  userOpenid: string,
  request: NextRequest,
): Promise<WechatPassiveReply | null> {
  const normalized = normalizeMenuEventKey(eventKey);

  if (normalized === MENU_CODE_KEY) {
    const cached = getCachedIdentityCodeReplyContent(userOpenid);
    if (cached) {
      return { kind: "text", content: cached };
    }
    return { kind: "text", content: await buildCachedIdentityCodeReplyContentV2(userOpenid) };
  }

  if (normalized === MENU_UPLOAD_KEY) {
    const duplicateReply = tryClaimWechatActionReply(userOpenid, "menu_upload");
    if (duplicateReply) {
      return { kind: "text", content: duplicateReply };
    }
    return { kind: "text", content: await buildUploadMenuReplyContentV2(userOpenid, request) };
  }

  if (normalized === MENU_GROUP_KEY) {
    if (!env.WECHAT_GROUP_QR_MEDIA_ID) {
      return { kind: "text", content: buildJoinGroupReplyContentV3() };
    }
    return { kind: "image", mediaId: env.WECHAT_GROUP_QR_MEDIA_ID };
  }

  if (normalized === MENU_CONTACT_KEY) {
    if (!env.WECHAT_CONTACT_QR_MEDIA_ID) {
      return { kind: "text", content: buildContactServiceReplyContentV3() };
    }
    return { kind: "image", mediaId: env.WECHAT_CONTACT_QR_MEDIA_ID };
  }

  return null;
}

async function handleFirstTimeNoV3(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return buildConsentRequiredReplyV3();
  }

  return buildUploadMenuReplyContentV2(userOpenid, request);
}

async function handleConsentV3(userOpenid: string): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  clearIdentityCodeReplyCache(userOpenid);

  if (participant) {
    await updateParticipantWorkflow(participant.id, {
      consent_confirmed: true,
      test_status: participant.test_status ?? "not_started",
      formal_status: participant.formal_status ?? "not_started",
    });
    await setWechatFlowStage(participant.id, "awaiting_test_start", "我同意");
    return buildConsentCompletedReplyV3();
  }

  const createResult = await createParticipant({
    wechatOpenid: userOpenid,
    status: "active",
    consentConfirmed: true,
    testStatus: "not_started",
    formalStatus: "not_started",
    extra: {
      wechat_flow_stage: "awaiting_test_start",
      wechat_onboarding_source: "wechat_consent_auto",
      wechat_onboarding_created_at: new Date().toISOString(),
      wechat_identity_code_claimed: false,
    },
  });

  const createdParticipant = createResult.participant;
  if (!createdParticipant) {
    return "系统暂时无法记录您的授权确认，请稍后再试。";
  }

  return buildConsentCompletedReplyV3();
}

async function handleWechatMenuClickV2(
  eventKey: string | null | undefined,
  userOpenid: string,
  request: NextRequest,
): Promise<WechatPassiveReply | null> {
  const normalized = normalizeMenuEventKey(eventKey);

  if (normalized === MENU_CODE_KEY) {
    const cached = getCachedIdentityCodeReplyContent(userOpenid);
    if (cached) {
      return { kind: "text", content: cached };
    }
    return { kind: "text", content: await buildCachedIdentityCodeReplyContentV2(userOpenid) };
  }

  if (normalized === MENU_UPLOAD_KEY) {
    const duplicateReply = tryClaimWechatActionReply(userOpenid, "menu_upload");
    if (duplicateReply) {
      return { kind: "text", content: duplicateReply };
    }
    return { kind: "text", content: await buildUploadMenuReplyContentV2(userOpenid, request) };
  }

  if (normalized === MENU_GROUP_KEY) {
    if (!env.WECHAT_GROUP_QR_MEDIA_ID) {
      return {
        kind: "text",
        content: "【加入社群】\n社群二维码暂未配置完成，请稍后再试或联系人工客服获取最新入群方式。",
      };
    }
    return {
      kind: "image",
      mediaId: env.WECHAT_GROUP_QR_MEDIA_ID,
    };
  }

  if (normalized === MENU_CONTACT_KEY) {
    if (!env.WECHAT_CONTACT_QR_MEDIA_ID) {
      return {
        kind: "text",
        content: buildContactServiceReplyContentV2(),
      };
    }
    return {
      kind: "image",
      mediaId: env.WECHAT_CONTACT_QR_MEDIA_ID,
    };
  }

  return null;
}

async function handleFirstTimeNoV2(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return buildConsentRequiredReplyV2();
  }

  return buildUploadMenuReplyContentV2(userOpenid, request);
}

async function handleConsentV2(userOpenid: string): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  clearIdentityCodeReplyCache(userOpenid);

  if (participant) {
    await updateParticipantWorkflow(participant.id, {
      consent_confirmed: true,
      test_status: participant.test_status ?? "not_started",
      formal_status: participant.formal_status ?? "not_started",
    });
    await setWechatFlowStage(participant.id, "awaiting_test_start", "我同意");
    return buildConsentCompletedReplyV2();
  }

  const createResult = await createParticipant({
    wechatOpenid: userOpenid,
    status: "active",
    consentConfirmed: true,
    testStatus: "not_started",
    formalStatus: "not_started",
    extra: {
      wechat_flow_stage: "awaiting_test_start",
      wechat_onboarding_source: "wechat_consent_auto",
      wechat_onboarding_created_at: new Date().toISOString(),
      wechat_identity_code_claimed: false,
    },
  });

  const createdParticipant = createResult.participant;
  if (!createdParticipant) {
    return "系统暂时无法记录您的授权确认，请稍后再试。";
  }

  return buildConsentCompletedReplyV2();
}

async function sendWechatAsyncTextReply(params: {
  openid: string;
  buildContent: () => Promise<string>;
  context: string;
}) {
  try {
    const content = await params.buildContent();
    const result = await sendWechatCustomTextMessage({
      openid: params.openid,
      content: decorateWechatReplyContent(content),
    });

    if (!result.ok) {
      console.error("[wechat] async custom message failed", {
        context: params.context,
        openid: params.openid,
        detail: result.detail,
      });
    }
  } catch (error) {
    console.error("[wechat] async reply build failed", {
      context: params.context,
      openid: params.openid,
      error,
    });

    const fallbackResult = await sendWechatCustomTextMessage({
      openid: params.openid,
      content: "⚠️ 系统繁忙，请稍后回复“是”再试一次。",
    });

    if (!fallbackResult.ok) {
      console.error("[wechat] async fallback message failed", {
        context: params.context,
        openid: params.openid,
        detail: fallbackResult.detail,
      });
    }
  }
}

function queueWechatAsyncReply(params: {
  openid: string;
  context: string;
  buildContent: () => Promise<string>;
}): string {
  after(async () => {
    await sendWechatAsyncTextReply(params);
  });

  return ASYNC_PROCESSING_REPLY;
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
    return buildConsentRequiredReply();
  }

  const workflow = parseParticipantWorkflowRow(participant);

  if (!workflow.consent_confirmed) {
    await setWechatFlowStage(participant.id, "awaiting_consent", "上传码");
    return buildConsentRequiredReply();
  }

  if (!hasClaimedIdentityCode(participant)) {
    return [
      "【请先获取身份码】",
      "你当前还没有完成身份码获取。",
      "请先完成以下步骤：",
      "1. 请点击菜单【获取身份码】；",
      "2. 获取身份码后，再点击菜单【上传】提交素材。",
      "身份码将用于识别你的上传记录、审核结果和后续结算信息。",
    ].join("\n");
  }

  if (workflow.test_status === "not_started" || workflow.test_status === "failed") {
    await setWechatFlowStage(participant.id, "awaiting_test_start", "上传码");
  } else if (workflow.test_status === "pending") {
    await setWechatFlowStage(participant.id, "test_ready", "上传码");
  } else {
    await setWechatFlowStage(participant.id, "formal_ready", "上传码");
  }

  return [
    "【📤上传入口】",
    "请点击下方链接进入上传页面：",
    buildH5Link(request, participant.participant_code),
    "你的身份码是：",
    `【${participant.participant_code}】`,
    "进入页面后，请填写 / 确认身份码，并按照任务要求上传视频素材。",
    ...REVIEW_SETTLEMENT_NOTICE_LINES,
    "请确保身份码填写正确，以便我们核对你的上传记录和结算信息。",
    "现在请点击链接开始上传。",
  ].join("\n");
}

function buildConsentRequiredReply(): string {
  return [
    "【请先完成授权确认】",
    "为了确保素材采集和使用合规，所有用户都需要先回复：",
    "【我同意】",
  ].join("\n");
}

function buildConsentCompletedReply(): string {
  return [
    "【✅授权确认成功】",
    "你已确认同意参与本次视频素材采集，并授权平台在合法合规范围内使用你提交的视频素材。",
    "请点击菜单【获取身份码】完成身份识别。",
  ].join("\n");
}

function getWorkflowStageLabelForChat(workflow: ReturnType<typeof parseParticipantWorkflowRow>): string {
  if (!workflow.consent_confirmed) {
    return "待确认参与";
  }
  if (workflow.test_status === "not_started") {
    return "待提交测试视频";
  }
  if (workflow.test_status === "failed") {
    return "测试未通过，待重新提交";
  }
  if (workflow.test_status === "pending") {
    return "测试视频审核中";
  }
  if (workflow.formal_status === "pending") {
    return "正式视频审核中";
  }
  return "已进入正式任务";
}

function getWorkflowNextStepText(workflow: ReturnType<typeof parseParticipantWorkflowRow>): string {
  if (!workflow.consent_confirmed) {
    return "下一步：请回复【我同意】确认参与。";
  }
  if (workflow.test_status === "not_started" || workflow.test_status === "failed") {
    return "下一步：请回复【开始测试】进入测试视频上传。";
  }
  return "下一步：请回复【开始】进入正式任务。";
}

async function buildIdentityCodeReplyContent(userOpenid: string): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);

  if (!participant) {
    return buildConsentRequiredReply();
  }

  const workflow = parseParticipantWorkflowRow(participant);
  if (!workflow.consent_confirmed) {
    return buildConsentRequiredReply();
  }

  if (!hasClaimedIdentityCode(participant)) {
    await markIdentityCodeClaimed(participant.id);
    return [
      "【🎉身份码获取成功】",
      "欢迎加入视频素材采集计划。",
      "你的专属身份码是：",
      `【${participant.participant_code}】`,
      "请妥善保存此身份码。后续视频上传、审核记录、任务结算和问题核对都将以该身份码为准。",
      "现在你可以点击菜单【上传】提交视频素材。",
    ].join("\n");
  }

  return [
    "【👋欢迎回来】",
    "你已完成授权确认。",
    "你的身份码是：",
    `【${participant.participant_code}】`,
    "后续视频上传、审核记录、任务结算和问题核对仍将以该身份码为准。",
    "现在你可以点击菜单【上传】继续提交素材。",
  ].join("\n");
}

async function buildUploadMenuReplyContent(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return buildConsentRequiredReply();
  }

  const workflow = parseParticipantWorkflowRow(participant);

  if (!workflow.consent_confirmed) {
    return buildConsentRequiredReply();
  }

  if (!hasClaimedIdentityCode(participant)) {
    return [
      "【请先获取身份码】",
      "你当前还没有完成身份码获取。",
      "请先完成以下步骤：",
      "1. 请点击菜单【获取身份码】；",
      "2. 获取身份码后，再点击菜单【上传】提交素材。",
      "身份码将用于识别你的上传记录、审核结果和后续结算信息。",
    ].join("\n");
  }

  const h5Link = buildH5Link(request, participant.participant_code);

  if (workflow.test_status === "not_started" || workflow.test_status === "failed") {
    await setWechatFlowStage(participant.id, "awaiting_test_start", "上传");
  } else if (workflow.test_status === "pending") {
    await setWechatFlowStage(participant.id, "test_ready", "上传");
  } else {
    await setWechatFlowStage(participant.id, "formal_ready", "上传");
  }

  return [
    "【📤视频上传入口】",
    "请点击下方链接进入上传页面：",
    h5Link,
    "你的身份码是：",
    `【${participant.participant_code}】`,
    "进入页面后，请填写 / 确认身份码，并按照任务要求上传视频素材。",
    ...REVIEW_SETTLEMENT_NOTICE_LINES,
    "请确保身份码填写正确，以便我们核对你的上传记录和结算信息。",
    "现在请点击链接开始上传。",
  ].join("\n");
}

async function buildCachedIdentityCodeReplyContent(userOpenid: string): Promise<string> {
  const cached = getCachedIdentityCodeReplyContent(userOpenid);
  if (cached) {
    return cached;
  }

  const content = await buildIdentityCodeReplyContent(userOpenid);
  return cacheIdentityCodeReplyContent(userOpenid, content);
}

async function buildIdentityCodeReplyContentV2(userOpenid: string): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return buildConsentRequiredReplyV2();
  }

  const workflow = parseParticipantWorkflowRow(participant);
  if (!workflow.consent_confirmed) {
    return buildConsentRequiredReplyV2();
  }

  if (!hasClaimedIdentityCode(participant)) {
    await markIdentityCodeClaimed(participant.id);
    return [
      "【身份码获取成功】",
      "欢迎加入视频素材采集计划。",
      "",
      "你的专属身份码是：",
      `【${participant.participant_code}】`,
      "",
      "请妥善保存此身份码。后续视频上传、审核记录、任务结算和问题核对都将以该身份码为准。",
      "现在你可以点击菜单【上传视频】提交视频素材。",
    ].join("\n");
  }

  return [
    "【欢迎回来】",
    "你已完成授权确认。",
    "",
    "你的身份码是：",
    `【${participant.participant_code}】`,
    "",
    "后续视频上传、审核记录、任务结算和问题核对仍将以该身份码为准。",
    "现在你可以点击菜单【上传视频】继续提交素材。",
  ].join("\n");
}

async function buildCachedIdentityCodeReplyContentV2(userOpenid: string): Promise<string> {
  const cached = getCachedIdentityCodeReplyContent(userOpenid);
  if (cached) {
    return cached;
  }

  const content = await buildIdentityCodeReplyContentV2(userOpenid);
  return cacheIdentityCodeReplyContent(userOpenid, content);
}

async function buildUploadMenuReplyContentV2(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return buildConsentRequiredReplyV2();
  }

  const workflow = parseParticipantWorkflowRow(participant);
  if (!workflow.consent_confirmed) {
    return buildConsentRequiredReplyV2();
  }

  if (!hasClaimedIdentityCode(participant)) {
    return [
      "【请先获取身份码】",
      "你当前还没有完成身份码获取。",
      "",
      "请先完成以下步骤：",
      "1. 点击菜单【获取身份码】",
      "2. 获取身份码后，再点击菜单【上传视频】提交素材",
      "",
      "身份码将用于识别你的上传记录、审核结果和后续结算信息。",
    ].join("\n");
  }

  const h5Link = buildH5Link(request, participant.participant_code);

  if (workflow.test_status === "not_started" || workflow.test_status === "failed") {
    await setWechatFlowStage(participant.id, "awaiting_test_start", "上传视频");
  } else if (workflow.test_status === "pending") {
    await setWechatFlowStage(participant.id, "test_ready", "上传视频");
  } else {
    await setWechatFlowStage(participant.id, "formal_ready", "上传视频");
  }

  return [
    "【视频上传入口】",
    "请点击下方链接进入上传页面：",
    h5Link,
    "",
    "你的身份码是：",
    `【${participant.participant_code}】`,
    "",
    "进入页面后，请填写 / 确认身份码，并按照任务要求上传视频素材。",
    ...REVIEW_SETTLEMENT_NOTICE_LINES_V2,
  ].join("\n");
}

function normalizeMenuEventKey(eventKey: string | null | undefined): string {
  return eventKey?.trim().toUpperCase() ?? "";
}

async function handleWechatMenuClick(
  eventKey: string | null | undefined,
  userOpenid: string,
  request: NextRequest,
): Promise<WechatPassiveReply | null> {
  const normalized = normalizeMenuEventKey(eventKey);

  if (normalized === MENU_GUIDE_KEY) {
    const duplicateReply = tryClaimWechatActionReply(userOpenid, "menu_guide");
    if (duplicateReply) {
      return { kind: "text", content: duplicateReply };
    }
    return { kind: "text", content: buildGuideReplyContent() };
  }

  if (normalized === MENU_CODE_KEY) {
    const cached = getCachedIdentityCodeReplyContent(userOpenid);
    if (cached) {
      return { kind: "text", content: cached };
    }
    return { kind: "text", content: await buildCachedIdentityCodeReplyContent(userOpenid) };
  }

  if (normalized === MENU_UPLOAD_KEY) {
    const duplicateReply = tryClaimWechatActionReply(userOpenid, "menu_upload");
    if (duplicateReply) {
      return { kind: "text", content: duplicateReply };
    }
    return { kind: "text", content: await buildUploadMenuReplyContent(userOpenid, request) };
  }

  if (normalized === MENU_ABOUT_KEY) {
    return { kind: "text", content: buildAboutUsReplyContent() };
  }

  if (normalized === MENU_STANDARD_KEY) {
    return { kind: "text", content: buildShootingStandardReplyContent() };
  }

  if (normalized === MENU_SAMPLE_KEY) {
    if (!env.WECHAT_SAMPLE_VIDEO_MEDIA_ID) {
      return {
        kind: "text",
        content: "样片视频还未配置完成，请稍后再试。",
      };
    }
    return {
      kind: "video",
      mediaId: env.WECHAT_SAMPLE_VIDEO_MEDIA_ID,
      title: SAMPLE_VIDEO_TITLE,
      description: SAMPLE_VIDEO_DESCRIPTION,
    };
  }

  if (normalized === MENU_CONTACT_KEY) {
    if (!env.WECHAT_CONTACT_QR_MEDIA_ID) {
      return {
        kind: "text",
        content: "客服二维码还未配置完成，请稍后再试。",
      };
    }
    return {
      kind: "image",
      mediaId: env.WECHAT_CONTACT_QR_MEDIA_ID,
    };
  }

  return null;
}

async function handleFirstTimeYes(userOpenid: string): Promise<string> {
  return [
    "【📌流程已更新】",
    "新用户无需再回复【是】。",
    "请直接回复【我同意】完成参与确认，然后点击菜单【获取身份码】。",
  ].join("\n");
}

async function handleFirstTimeNo(userOpenid: string, request: NextRequest): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  if (!participant) {
    return buildConsentRequiredReply();
  }

  return buildUploadMenuReplyContent(userOpenid, request);
}

async function handleConsent(userOpenid: string): Promise<string> {
  const participant = await findParticipantByOpenId(userOpenid);
  clearIdentityCodeReplyCache(userOpenid);

  if (participant) {
    await updateParticipantWorkflow(participant.id, {
      consent_confirmed: true,
      test_status: participant.test_status ?? "not_started",
      formal_status: participant.formal_status ?? "not_started",
    });
    await setWechatFlowStage(participant.id, "awaiting_test_start", "我同意");
    return buildConsentCompletedReply();
  }

  const createResult = await createParticipant({
    wechatOpenid: userOpenid,
    status: "active",
    consentConfirmed: true,
    testStatus: "not_started",
    formalStatus: "not_started",
    extra: {
      wechat_flow_stage: "awaiting_test_start",
      wechat_onboarding_source: "wechat_consent_auto",
      wechat_onboarding_created_at: new Date().toISOString(),
      wechat_identity_code_claimed: false,
    },
  });

  const createdParticipant = createResult.participant;
  if (!createdParticipant) {
    return "系统暂时无法记录你的参与确认，请稍后再试。";
  }

  return buildConsentCompletedReply();
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
    eventKey: inbound.eventKey ?? null,
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
    after(async () => {
      try {
        const result = await sendWechatCustomTextMessage({
          openid: userOpenid,
          content: decorateWechatReplyContent(buildAuthorizationPromptReplyV3()),
        });

        if (!result.ok) {
          console.error("[wechat] async custom message failed", {
            context: "subscribe_authorization_prompt",
            openid: userOpenid,
            detail: result.detail,
          });
        }
      } catch (error) {
        console.error("[wechat] async custom message build failed", {
          context: "subscribe_authorization_prompt",
          openid: userOpenid,
          error,
        });
      }
    });

    return xmlResponse(
      buildWechatPassiveTextReply({
        toUserOpenid: userOpenid,
        fromOfficialUserName: officialId,
        content: buildWelcomeReplyV4(),
      }),
    );
  }

  if (inbound.msgType === "event") {
    const eventName = inbound.event?.trim().toLowerCase() ?? "";
    if (eventName === "click") {
      const reply = await handleWechatMenuClickV3(inbound.eventKey, userOpenid, request);
      if (reply) {
        return renderWechatPassiveReply({
          reply,
          toUserOpenid: userOpenid,
          fromOfficialUserName: officialId,
        });
      }
    }
  }

  if (inbound.msgType === "text") {
    let content: string | null = null;

    if (isFirstTimeYesKeyword(normalizedText)) {
      content = tryClaimWechatActionReply(userOpenid, "first_time_yes");
      if (content) {
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content,
          }),
        );
      }
      content = queueWechatAsyncReply({
        openid: userOpenid,
        context: "first_time_yes",
        buildContent: () => handleFirstTimeYes(userOpenid),
      });
    } else if (isFirstTimeNoKeyword(normalizedText)) {
      content = tryClaimWechatActionReply(userOpenid, "first_time_no");
      if (content) {
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content,
          }),
        );
      }
      content = queueWechatAsyncReply({
        openid: userOpenid,
        context: "first_time_no",
        buildContent: () => handleFirstTimeNoV3(userOpenid, request),
      });
    } else if (isAgreeKeyword(normalizedText)) {
      content = tryClaimWechatActionReply(userOpenid, "consent");
      if (content) {
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content,
          }),
        );
      }
      content = queueWechatAsyncReply({
        openid: userOpenid,
        context: "consent",
        buildContent: () => handleConsentV3(userOpenid),
      });
    } else if (isStartTestKeyword(normalizedText) || normalizedText === "重新测试") {
      content = tryClaimWechatActionReply(userOpenid, normalizedText === "重新测试" ? "restart_test" : "start_test");
      if (content) {
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content,
          }),
        );
      }
      content = queueWechatAsyncReply({
        openid: userOpenid,
        context: normalizedText === "重新测试" ? "restart_test" : "start_test",
        buildContent: () => handleStartTest(userOpenid, request),
      });
    } else if (isStartFormalKeyword(normalizedText)) {
      content = tryClaimWechatActionReply(userOpenid, "start_formal");
      if (content) {
        return xmlResponse(
          buildWechatPassiveTextReply({
            toUserOpenid: userOpenid,
            fromOfficialUserName: officialId,
            content,
          }),
        );
      }
      content = queueWechatAsyncReply({
        openid: userOpenid,
        context: "start_formal",
        buildContent: () => handleStartFormal(userOpenid, request),
      });
    } else if (isGuideTextKeyword(normalizedText) || isHelpTextKeyword(normalizedText)) {
      content = buildGuideReplyContentV3();
    } else if (isIdentityCodeKeyword(normalizedText)) {
      content = await buildCachedIdentityCodeReplyContentV2(userOpenid);
    } else if (isManualTextKeyword(normalizedText)) {
      content = buildManualReplyContentV3();
    } else {
      content = buildUnknownCommandReply();
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
