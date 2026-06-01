import os from "node:os";
import { randomUUID } from "node:crypto";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";

const { Pool } = pg;

const env = {
  DATABASE_URL: readEnv("DATABASE_URL"),
  OPENAI_API_KEY: readEnv("OPENAI_API_KEY"),
  DASHSCOPE_API_KEY: readEnv("DASHSCOPE_API_KEY"),
  ALIYUN_API_KEY: readEnv("ALIYUN_API_KEY"),
  OPENAI_BASE_URL: readEnv("OPENAI_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  OPENAI_VIDEO_REVIEW_MODEL: readEnv("OPENAI_VIDEO_REVIEW_MODEL") || "qwen-vl-plus",
  ALIYUN_VIDEO_REVIEW_INTERVAL_MS: readEnv("ALIYUN_VIDEO_REVIEW_INTERVAL_MS"),
  ALIYUN_VIDEO_REVIEW_IMAGE_LIMIT: readEnv("ALIYUN_VIDEO_REVIEW_IMAGE_LIMIT"),
  ALIYUN_VIDEO_REVIEW_TIMEOUT_MS: readEnv("ALIYUN_VIDEO_REVIEW_TIMEOUT_MS"),
  ALIYUN_VIDEO_REVIEW_URL_EXPIRES_IN: readEnv("ALIYUN_VIDEO_REVIEW_URL_EXPIRES_IN"),
  COS_SECRET_ID: readEnv("COS_SECRET_ID"),
  COS_SECRET_KEY: readEnv("COS_SECRET_KEY"),
  COS_REGION: readEnv("COS_REGION"),
  COS_BUCKET: readEnv("COS_BUCKET"),
};

const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const pollIntervalMs = parseBoundedInteger(env.ALIYUN_VIDEO_REVIEW_INTERVAL_MS, 30_000, 5_000, 300_000);
const imageLimit = parseBoundedInteger(env.ALIYUN_VIDEO_REVIEW_IMAGE_LIMIT, 4, 1, 8);
const requestTimeoutMs = parseBoundedInteger(env.ALIYUN_VIDEO_REVIEW_TIMEOUT_MS, 180_000, 30_000, 600_000);
const signedUrlExpiresIn = parseBoundedInteger(env.ALIYUN_VIDEO_REVIEW_URL_EXPIRES_IN, 3_600, 300, 43_200);
const modelApiKey = env.DASHSCOPE_API_KEY || env.ALIYUN_API_KEY || env.OPENAI_API_KEY;
const sceneCodeToLabel = Object.freeze({
  kitchen: "厨房",
  living_room: "客厅",
  bedroom: "卧室",
  bathroom: "卫生间",
  general_housework: "通用家务动作",
  other: "其他",
  unknown: "无法判断",
});
const sceneOptionsText = Object.entries(sceneCodeToLabel).map(([code, label]) => `${code}=${label}`).join(", ");

if (!env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}
if (!modelApiKey) {
  throw new Error("Missing DASHSCOPE_API_KEY, ALIYUN_API_KEY, or OPENAI_API_KEY");
}
if (!env.COS_SECRET_ID || !env.COS_SECRET_KEY || !env.COS_REGION || !env.COS_BUCKET) {
  throw new Error("Missing Tencent COS config");
}

let dbPool = null;
let storageClient = null;
let shuttingDown = false;

function readEnv(name) {
  return process.env[name]?.trim() ?? "";
}

function parseBoundedInteger(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function getDbPool() {
  if (dbPool) {
    return dbPool;
  }
  dbPool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return dbPool;
}

function getStorageClient() {
  if (storageClient) {
    return storageClient;
  }
  storageClient = new S3Client({
    region: env.COS_REGION,
    endpoint: `https://cos.${env.COS_REGION}.myqcloud.com`,
    credentials: {
      accessKeyId: env.COS_SECRET_ID,
      secretAccessKey: env.COS_SECRET_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return storageClient;
}

function buildOpenAiUrl(pathname) {
  const base = env.OPENAI_BASE_URL.replace(/\/+$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSignedGetUrl(objectKey, bucket = env.COS_BUCKET, expiresIn = signedUrlExpiresIn) {
  return getSignedUrl(
    getStorageClient(),
    new GetObjectCommand({
      Bucket: bucket || env.COS_BUCKET,
      Key: objectKey,
    }),
    { expiresIn },
  );
}

async function claimNextSubmission() {
  const result = await getDbPool().query(
    `with candidate as (
       select id
       from public.video_submissions
       where analysis_status = 'preprocess_ready'
         and contact_sheet_count > 0
         and (lease_expires_at is null or lease_expires_at < now())
       order by id asc
       for update skip locked
       limit 1
     )
     update public.video_submissions as s
     set analysis_status = 'running',
         analysis_decision = null,
         analysis_ratio = null,
         analysis_summary = 'Aliyun Qwen visual review running',
         analysis_payload = jsonb_build_object(
           'provider', 'aliyun_qwen_sync',
           'stage', 'running',
           'worker_id', $1::text
         ),
         analysis_started_at = coalesce(s.analysis_started_at, now()),
         analysis_completed_at = null,
         last_error = null,
         lease_owner = $1::text,
         lease_expires_at = now() + interval '20 minutes'
     from candidate
     where s.id = candidate.id
     returning s.*`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

async function releaseExpiredSyncLeases() {
  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = 'preprocess_ready',
         analysis_summary = 'Aliyun Qwen visual review lease expired; queued again',
         lease_owner = null,
         lease_expires_at = null
     where analysis_status = 'running'
       and lease_expires_at < now()
       and analysis_payload->>'provider' = 'aliyun_qwen_sync'`,
  );
}

async function getContactSheetArtifacts(submission) {
  const result = await getDbPool().query(
    `select *
     from public.video_submission_artifacts
     where submission_id = $1
       and artifact_type = 'contact_sheet'
     order by preprocess_version desc, segment_index asc, id asc
     limit $2`,
    [submission.id, imageLimit],
  );
  return result.rows;
}

function buildReviewPrompt(submission, artifacts) {
  const artifactEvidence = artifacts
    .map((artifact, index) => {
      const timePoints = Array.isArray(artifact.time_points_json)
        ? artifact.time_points_json
        : artifact.time_points_json ?? [];
      const metadata = artifact.metadata_json && typeof artifact.metadata_json === "object" ? artifact.metadata_json : {};
      return [
        `- contact_sheet_${index + 1}:`,
        `  - segment_index: ${artifact.segment_index ?? ""}`,
        `  - image_size: ${artifact.width ?? ""}x${artifact.height ?? ""}`,
        `  - time_points_sec: ${JSON.stringify(timePoints)}`,
        `  - segment_start_sec: ${metadata.segment_start_sec ?? ""}`,
        `  - segment_end_sec: ${metadata.segment_end_sec ?? ""}`,
        `  - grid: ${metadata.columns ?? ""} columns x ${metadata.rows ?? ""} rows`,
        `  - effective_viewport: ${JSON.stringify(metadata.effective_viewport ?? {})}`,
      ].join("\n");
    })
    .join("\n");

  return `
你是视频质量审核助手。请根据同一段视频的时间序列抽帧图，判断该视频是否适合作为第一视角双手操作数据，并返回结构化 JSON。
请只基于抽帧图和证据信息做判断；证据不足时不要推断失败，也不要因为无法确认的项目直接判定不合格。

审核目标：
1. 画面方向和可用区域是否明显影响动作识别。
2. 画面是否足够清晰、稳定，能否观察手部动作。
3. 视角是否接近第一视角，是否能看到操作者双手和操作区域。
4. 双手动作在视频时长中的可识别比例。
5. 主要拍摄场景。

判定原则：
- 如果整体画面可用、接近第一视角、双手动作大部分时间可识别，且没有明确持续的严重问题，decision 返回 auto_pass。
- 只有当问题在多个时间点反复出现或持续存在，并且严重影响整体动作识别时，decision 才返回 auto_reject。
- 如果抽帧图不足以确认 FOV、分辨率、帧率、总时长等关键项，或只看到轻微/短暂问题，不要直接拒绝，decision 返回 review_needed 或 auto_pass。
- 不要因为单个抽帧异常、短暂出框、轻微模糊、轻微抖动、少量黑边直接判定 auto_reject。
- ratio 表示双手动作可识别时长占总时长的估计比例，范围 0 到 1；估算时应按整体动作链判断，不要过度惩罚抽帧间隔造成的信息缺口。
- hard_fail_reasons 只能从枚举中选择；只有在证据明确时填写，没有明确原因时返回空数组 []。

双手有效出镜标准：
- 左手和右手同时可见或共同参与主要操作。
- 双手主要轮廓、动作意图和操作对象基本可识别。
- 手腕或小臂有一定程度出镜更好，但短暂缺失不直接判失败。
- 轻微裁切、短暂出框、手指尖或手掌边缘擦边，只要不影响动作理解，可以计入有效时长。

无效时间段：
- 长时间只有一只手，或双手长期离开画面。
- 只看到零碎手指，且无法理解动作。
- 双手被严重遮挡、严重裁切，导致动作不可识别。
- 画面严重过暗、模糊、抖动或卡顿，导致动作不可识别。
- 明显不是第一视角操作视频。

最终判定：
- 双手有效动作比例估计 >= 65%，且无明确持续硬失败，判定 auto_pass。
- 双手有效动作比例明显 < 65%，或存在明确持续硬失败，判定 auto_reject。
- 对 FOV、分辨率、FPS 等无法仅凭抽帧确认时，不要作为 auto_reject 的唯一原因，判定 review_needed。

场景识别：
- 请只根据画面环境和操作内容判断主要场景，不要只根据用户选择、文件名或备注判断。
- scene_code 只能从以下枚举中选择：${sceneOptionsText}。
- 如果无法判断具体场景，返回 unknown；如果不属于枚举中的家庭场景但能看出其他场景，返回 other。

提交信息：
- submission_id: ${submission.id}
- participant_code: ${submission.participant_code ?? ""}
- selected_scene: ${submission.scene ?? "未选择"}
- file_name: ${submission.file_name ?? ""}
- size_bytes: ${submission.size_bytes ?? ""}
- mime: ${submission.mime ?? ""}
- duration_sec_metadata: ${submission.duration_sec ?? ""}
- uploaded_at: ${submission.created_at ?? ""}
- contact_sheet_count_used: ${artifacts.length}

抽帧证据信息：
${artifactEvidence || "- 未提供"}

hard_fail_reasons 枚举：
vertical_video, portrait_content_in_landscape_canvas, large_black_bars, rotated_video, narrow_fov, low_resolution_or_blurry, low_fps_or_choppy, severe_motion_blur, one_hand_only, hands_mostly_out_of_frame, not_egocentric, valid_ratio_below_65

只返回 JSON，不要 Markdown，不要解释。所有中文字段请使用简体中文。结构如下：
{
  "decision": "auto_pass | auto_reject | review_needed",
  "ratio": 0.0,
  "confidence": 0.0,
  "summary": "中文综合判断",
  "scene_detection": {
    "scene_code": "kitchen | living_room | bedroom | bathroom | general_housework | other | unknown",
    "scene_label": "厨房 | 客厅 | 卧室 | 卫生间 | 通用家务动作 | 其他 | 无法判断",
    "confidence": 0.0,
    "reason": "中文说明判断依据"
  },
  "basic_info": {
    "estimated_total_seconds": 0,
    "orientation": "正常横屏 | 自然竖屏第一视角 | 旋转错误 | 大面积黑边 | 横屏画布嵌入竖屏内容 | 疑似异常",
    "egocentric": "符合 | 不符合 | 需复核",
    "fov": "疑似 >=120° | 疑似不足 120° | 无法确认",
    "resolution": ">=1080p | 疑似低于 1080p | 无法确认",
    "fps": ">=30fps | 疑似低于 30fps | 无法确认"
  },
  "hand_visibility": {
    "valid_seconds_estimate": 0,
    "valid_ratio_percent": 0,
    "meets_65_percent": true,
    "minor_out_of_frame_but_recognizable": true
  },
  "issue_timeline": [
    {
      "time_range": "00:03-00:08",
      "reason": "中文说明",
      "counts_as_valid": true
    }
  ],
  "hard_fail_reasons": [],
  "final_conclusion_cn": "合格 | 不合格 | 需人工复核"
}
`.trim();
}

function extractOutputText(responseBody) {
  const content = responseBody?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        if (typeof part?.content === "string") {
          return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function parseReviewJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("Empty model output");
  }
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1));
    }
    throw new Error(`Model output is not valid JSON: ${unfenced.slice(0, 500)}`);
  }
}

function normalizeDecision(value) {
  const decision = String(value ?? "review_needed").trim();
  return decision === "auto_pass" || decision === "auto_reject" || decision === "review_needed"
    ? decision
    : "review_needed";
}

function normalizeRatio(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed > 1 && parsed <= 100) {
    return Math.max(0, Math.min(1, parsed / 100));
  }
  return Math.max(0, Math.min(1, parsed));
}

function normalizeReviewRatio(review) {
  const ratio = normalizeRatio(review?.ratio);
  if (ratio !== null) {
    return ratio;
  }
  return normalizeRatio(review?.hand_visibility?.valid_ratio_percent);
}

function normalizeSceneConfidence(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed > 1 && parsed <= 100) {
    return Math.max(0, Math.min(1, parsed / 100));
  }
  return Math.max(0, Math.min(1, parsed));
}

function normalizeSceneCode(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "unknown";
  }
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (Object.prototype.hasOwnProperty.call(sceneCodeToLabel, normalized)) {
    return normalized;
  }
  for (const [code, label] of Object.entries(sceneCodeToLabel)) {
    if (raw === label) {
      return code;
    }
  }
  return "unknown";
}

function extractSceneDetection(review) {
  const source = review && typeof review === "object" && !Array.isArray(review) ? review : {};
  const detection = source.scene_detection && typeof source.scene_detection === "object" && !Array.isArray(source.scene_detection)
    ? source.scene_detection
    : {};
  const sceneCode = normalizeSceneCode(
    detection.scene_code ?? detection.scene ?? detection.scene_label ?? source.scene_code ?? source.ai_scene,
  );
  const confidence = normalizeSceneConfidence(detection.confidence ?? source.scene_confidence);
  const scene = sceneCode === "unknown" ? null : sceneCodeToLabel[sceneCode];

  return {
    sceneCode,
    scene,
    confidence,
    reason: typeof detection.reason === "string" ? detection.reason.slice(0, 1000) : null,
  };
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function textIncludesAny(value, needles) {
  const text = normalizeText(value);
  return needles.some((needle) => text.includes(needle));
}

function appendUnique(list, value) {
  if (value && !list.includes(value)) {
    list.push(value);
  }
}

function normalizeReasonList(value) {
  const rawItems = Array.isArray(value) ? value : value ? [value] : [];
  return rawItems.map((item) => normalizeText(item)).filter(Boolean);
}

function isUncertain(value) {
  return textIncludesAny(value, ["无法确认", "需复核", "疑似异常"]);
}

function textHasAffirmedAny(value, badNeedles, negatedNeedles = []) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  if (negatedNeedles.some((needle) => text.includes(needle))) {
    return false;
  }
  return badNeedles.some((needle) => text.includes(needle));
}

function getArtifactGuardrailReasons(artifacts) {
  const reasons = [];
  for (const artifact of artifacts) {
    const metadata = artifact?.metadata_json && typeof artifact.metadata_json === "object" ? artifact.metadata_json : {};
    const viewport = metadata.effective_viewport && typeof metadata.effective_viewport === "object"
      ? metadata.effective_viewport
      : {};
    if (viewport.large_black_bars === true) {
      appendUnique(reasons, "large_black_bars");
    }
    if (viewport.portrait_content_in_landscape_canvas === true) {
      appendUnique(reasons, "portrait_content_in_landscape_canvas");
    }
  }
  return reasons;
}

function applyReviewGuardrails(review, artifactGuardrailReasons = []) {
  const originalReview = review && typeof review === "object" && !Array.isArray(review) ? review : {};
  const guardedReview = {
    ...originalReview,
    basic_info: {
      ...(originalReview.basic_info && typeof originalReview.basic_info === "object" ? originalReview.basic_info : {}),
    },
    hand_visibility: {
      ...(originalReview.hand_visibility && typeof originalReview.hand_visibility === "object"
        ? originalReview.hand_visibility
        : {}),
    },
  };
  const originalDecision = normalizeDecision(guardedReview.decision);
  const hardFailReasons = normalizeReasonList(guardedReview.hard_fail_reasons).filter(
    (reason) => reason !== "vertical_video",
  );
  const guardrailReasons = [...artifactGuardrailReasons];
  const reviewNeededReasons = [];
  const basicInfo = guardedReview.basic_info;
  const handVisibility = guardedReview.hand_visibility;
  const orientation = basicInfo.orientation;
  const ratio = normalizeReviewRatio(guardedReview);

  if (!textIncludesAny(orientation, ["正常横屏", "自然竖屏第一视角"])) {
    if (textHasAffirmedAny(orientation, ["旋转错误", "旋转 90", "旋转90"], ["无旋转", "没有旋转", "未见旋转", "不存在旋转"])) {
      appendUnique(guardrailReasons, "rotated_video");
    }
    if (textHasAffirmedAny(orientation, ["竖屏黑边", "大面积黑边", "黑边"], ["无黑边", "没有黑边", "未见黑边", "不存在黑边"])) {
      appendUnique(guardrailReasons, "large_black_bars");
    }
    if (textHasAffirmedAny(orientation, ["竖屏"], ["自然竖屏第一视角", "非竖屏", "不是竖屏", "无竖屏", "不存在竖屏"])) {
      appendUnique(guardrailReasons, "vertical_video");
    }
    if (
      textHasAffirmedAny(
        orientation,
        ["横屏画布嵌入竖屏内容", "竖屏内容区域", "有效内容区域是竖屏", "疑似异常", "异常"],
        ["自然竖屏第一视角", "无异常", "没有异常", "未见异常", "不存在异常"],
      )
    ) {
      appendUnique(guardrailReasons, "portrait_content_in_landscape_canvas");
    }
  }
  if (textIncludesAny(basicInfo.egocentric, ["不符合"])) {
    appendUnique(guardrailReasons, "not_egocentric");
  }
  if (textHasAffirmedAny(basicInfo.fov, ["疑似不足", "不足", "过窄", "视角较窄"], ["无明显不足", "未见不足", "没有不足"])) {
    appendUnique(guardrailReasons, "narrow_fov");
  }
  if (
    textHasAffirmedAny(
      basicInfo.resolution,
      ["疑似低于", "低于", "低清", "严重模糊", "明显模糊", "无法识别", "马赛克", "噪点严重"],
      ["无明显模糊", "未见明显模糊", "没有明显模糊", "无明显压缩", "画面清晰", ">=1080p"],
    )
  ) {
    appendUnique(guardrailReasons, "low_resolution_or_blurry");
  }
  if (
    textHasAffirmedAny(
      basicInfo.fps,
      ["疑似低于", "低于", "明显卡顿", "严重卡顿", "卡顿严重", "跳帧", "拖影", "动作断裂", "不流畅"],
      ["无明显卡顿", "未见明显卡顿", "没有明显卡顿", "不卡顿", "画面流畅", "动作流畅", ">=30fps"],
    )
  ) {
    appendUnique(guardrailReasons, "low_fps_or_choppy");
  }
  if (handVisibility.meets_65_percent === false || (ratio !== null && ratio < 0.65)) {
    appendUnique(guardrailReasons, "valid_ratio_below_65");
  }

  const uncertaintyChecks = [
    ["fov_uncertain", basicInfo.fov],
    ["resolution_uncertain", basicInfo.resolution],
    ["fps_uncertain", basicInfo.fps],
  ];
  for (const [reason, value] of uncertaintyChecks) {
    if (isUncertain(value)) {
      appendUnique(reviewNeededReasons, reason);
    }
  }

  const combinedHardFailReasons = [...hardFailReasons];
  for (const reason of guardrailReasons) {
    appendUnique(combinedHardFailReasons, reason);
  }

  let finalDecision = originalDecision;
  if (combinedHardFailReasons.length > 0) {
    finalDecision = "auto_reject";
  } else if (originalDecision === "auto_pass" && reviewNeededReasons.length >= 2) {
    finalDecision = "review_needed";
  }

  guardedReview.decision = finalDecision;
  guardedReview.hard_fail_reasons = combinedHardFailReasons;
  if (ratio !== null && normalizeRatio(guardedReview.ratio) === null) {
    guardedReview.ratio = ratio;
  }

  const applied = finalDecision !== originalDecision || guardrailReasons.length > 0;
  if (applied) {
    const guardrailSummary = `系统兜底：${finalDecision === "auto_reject" ? "命中硬失败规则" : "关键信息不足，需人工复核"}。`;
    guardedReview.summary = `${guardrailSummary}${normalizeText(guardedReview.summary)}`.slice(0, 4000);
  }

  return {
    review: guardedReview,
    guardrails: {
      applied,
      original_decision: originalDecision,
      final_decision: finalDecision,
      model_hard_fail_reasons: hardFailReasons,
      added_hard_fail_reasons: guardrailReasons,
      review_needed_reasons: reviewNeededReasons,
    },
  };
}

async function callModel(submission, artifacts) {
  const urls = await Promise.all(
    artifacts.map(async (artifact) => ({
      artifact,
      url: await createSignedGetUrl(artifact.object_key, artifact.bucket || env.COS_BUCKET),
    })),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(buildOpenAiUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${modelApiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: env.OPENAI_VIDEO_REVIEW_MODEL,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildReviewPrompt(submission, artifacts),
              },
              ...urls.map(({ url }) => ({
                type: "image_url",
                image_url: { url },
              })),
            ],
          },
        ],
      }),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`Aliyun Qwen review failed: ${response.status} ${text.slice(0, 1000)}`);
    }
    return {
      body,
      artifactKeys: urls.map(({ artifact }) => artifact.object_key),
      review: parseReviewJson(extractOutputText(body)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function markSubmissionSucceeded(submission, modelResult, artifacts) {
  const artifactGuardrailReasons = getArtifactGuardrailReasons(artifacts);
  const guarded = applyReviewGuardrails(modelResult.review, artifactGuardrailReasons);
  const decision = normalizeDecision(guarded.review.decision);
  const ratio = normalizeReviewRatio(guarded.review);
  const summary = String(guarded.review.summary ?? guarded.review.final_conclusion_cn ?? decision).slice(0, 4000);
  const sceneDetection = extractSceneDetection(guarded.review);
  const payload = {
    provider: "aliyun_qwen_sync",
    model: env.OPENAI_VIDEO_REVIEW_MODEL,
    base_url: env.OPENAI_BASE_URL,
    artifact_keys: modelResult.artifactKeys,
    scene_detection: sceneDetection,
    review: guarded.review,
    model_review: modelResult.review,
    review_guardrails: guarded.guardrails,
    artifact_guardrail_reasons: artifactGuardrailReasons,
    model_response: modelResult.body,
  };

  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = 'succeeded',
         analysis_decision = $1,
         analysis_ratio = $2,
         analysis_summary = $3,
         analysis_payload = $4::jsonb,
         ai_scene = $5,
         ai_scene_confidence = $6,
         scene_match_status = case
           when $5::text is null then 'unknown'
           when scene is null or btrim(scene) = '' then 'unknown'
           when btrim(scene) = btrim($5::text) then 'match'
           else 'mismatch'
         end,
         scene = coalesce(nullif(scene, ''), $5::text),
         scene_reviewed_at = now(),
         analysis_completed_at = now(),
         last_error = null,
         lease_owner = null,
         lease_expires_at = null
     where id = $7`,
    [decision, ratio, summary, JSON.stringify(payload), sceneDetection.scene, sceneDetection.confidence, submission.id],
  );

  return { decision, ratio, guardrails: guarded.guardrails, scene: sceneDetection.scene };
}

function isDataInspectionFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("data_inspection_failed") || message.includes("Input data may contain inappropriate content");
}

async function markSubmissionFailed(submission, error, artifacts = []) {
  const message = error instanceof Error ? error.message : String(error);
  if (isDataInspectionFailure(error)) {
    const summary = "Qwen data inspection blocked input; manual review needed";
    const payload = {
      provider: "aliyun_qwen_sync",
      model: env.OPENAI_VIDEO_REVIEW_MODEL,
      stage: "data_inspection_blocked",
      artifact_keys: artifacts.map((artifact) => artifact.object_key),
      error: message,
    };

    await getDbPool().query(
      `update public.video_submissions
       set analysis_status = 'succeeded',
           analysis_decision = 'review_needed',
           analysis_ratio = null,
           analysis_summary = $1,
           analysis_payload = $2::jsonb,
           analysis_completed_at = now(),
           last_error = null,
           lease_owner = null,
           lease_expires_at = null
       where id = $3`,
      [summary, JSON.stringify(payload), submission.id],
    );
    return;
  }

  const payload = {
    provider: "aliyun_qwen_sync",
    model: env.OPENAI_VIDEO_REVIEW_MODEL,
    stage: "review_failed",
    artifact_keys: artifacts.map((artifact) => artifact.object_key),
    error: message,
  };

  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = 'failed',
         analysis_summary = $1,
         analysis_payload = $2::jsonb,
         analysis_completed_at = now(),
         last_error = $1,
         lease_owner = null,
         lease_expires_at = null
     where id = $3`,
    [message.slice(0, 4000), JSON.stringify(payload), submission.id],
  );
}

async function processSubmission(submission) {
  console.info("aliyun video review started", {
    workerId,
    submissionId: submission.id,
    model: env.OPENAI_VIDEO_REVIEW_MODEL,
  });

  const artifacts = await getContactSheetArtifacts(submission);
  if (artifacts.length === 0) {
    throw new Error("No contact sheet artifacts found for preprocess_ready submission");
  }

  try {
    const modelResult = await callModel(submission, artifacts);
    const storedResult = await markSubmissionSucceeded(submission, modelResult, artifacts);
    console.info("aliyun video review completed", {
      workerId,
      submissionId: submission.id,
      decision: storedResult.decision,
      ratio: storedResult.ratio,
      scene: storedResult.scene,
      guardrailApplied: storedResult.guardrails.applied,
    });
  } catch (error) {
    await markSubmissionFailed(submission, error, artifacts);
    throw error;
  }
}

async function runLoop() {
  console.info("aliyun video review worker started", {
    workerId,
    model: env.OPENAI_VIDEO_REVIEW_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
    pollIntervalMs,
    imageLimit,
  });

  while (!shuttingDown) {
    await releaseExpiredSyncLeases();
    const submission = await claimNextSubmission();
    if (!submission) {
      await sleep(pollIntervalMs);
      continue;
    }

    try {
      await processSubmission(submission);
    } catch (error) {
      console.error("aliyun video review failed", {
        workerId,
        submissionId: submission.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function shutdown(signal) {
  console.info("aliyun video review worker shutting down", { workerId, signal });
  shuttingDown = true;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await runLoop();
} finally {
  await dbPool?.end().catch(() => {});
}
