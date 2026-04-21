import type { ParticipantRow, VideoSubmissionRow } from "@/lib/video-submissions";

export const H5_SCENES = [
  "厨房",
  "客厅",
  "卧室",
  "卫生间",
  "通用家务动作",
] as const;

export type H5Scene = (typeof H5_SCENES)[number];
export type H5UploadKind = "test" | "formal";
export type H5TestStatus = "not_started" | "pending" | "passed" | "failed";
export type H5FormalStatus = "not_started" | "pending" | "reviewed";

export type ParticipantWorkflowExtra = {
  consent_confirmed: boolean;
  test_status: H5TestStatus;
  formal_status: H5FormalStatus;
};

export type ParticipantWorkflowStage =
  | "new_unconfirmed"
  | "test_pending_start"
  | "test_uploaded_pending_review"
  | "test_failed"
  | "formal_available"
  | "formal_uploaded_pending_review";

export type DerivedWorkflowState = {
  consent_confirmed: boolean;
  test_status: H5TestStatus;
  formal_status: H5FormalStatus;
  stage: ParticipantWorkflowStage;
  current_upload_kind: H5UploadKind | null;
  current_title: string;
  current_description: string;
  can_upload: boolean;
  tips: string[];
};

export type SubmissionMeta = {
  kind: H5UploadKind | null;
  scene: string | null;
  note: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTestStatus(value: unknown): H5TestStatus {
  return value === "pending" || value === "passed" || value === "failed" ? value : "not_started";
}

function normalizeFormalStatus(value: unknown): H5FormalStatus {
  return value === "pending" || value === "reviewed" ? value : "not_started";
}

export function getParticipantWorkflowExtra(extra: Record<string, unknown> | null | undefined): ParticipantWorkflowExtra {
  const record = isRecord(extra) ? extra : {};
  return {
    consent_confirmed: record.consent_confirmed !== false,
    test_status: normalizeTestStatus(record.test_status),
    formal_status: normalizeFormalStatus(record.formal_status),
  };
}

export function parseParticipantWorkflowRow(participant: ParticipantRow): ParticipantWorkflowExtra {
  const fallback = getParticipantWorkflowExtra(participant.extra);
  return {
    consent_confirmed: participant.consent_confirmed ?? fallback.consent_confirmed,
    test_status: participant.test_status ?? fallback.test_status,
    formal_status: participant.formal_status ?? fallback.formal_status,
  };
}

export function parseSubmissionMeta(userComment: string | null | undefined): SubmissionMeta {
  if (!userComment) {
    return { kind: null, scene: null, note: null };
  }

  const trimmed = userComment.trim();
  if (!trimmed.startsWith("__meta__:")) {
    return {
      kind: null,
      scene: null,
      note: trimmed || null,
    };
  }

  const [header, ...rest] = trimmed.split("\n");
  const rawPairs = header.slice("__meta__:".length).split(";");
  const fields = new Map<string, string>();

  for (const pair of rawPairs) {
    const [rawKey, ...rawValue] = pair.split("=");
    const key = rawKey?.trim();
    const value = rawValue.join("=").trim();
    if (!key) {
      continue;
    }
    fields.set(key, decodeURIComponent(value));
  }

  const kindValue = fields.get("kind");
  const sceneValue = fields.get("scene");
  const note = rest.join("\n").trim() || null;

  return {
    kind: kindValue === "test" || kindValue === "formal" ? kindValue : null,
    scene: sceneValue || null,
    note,
  };
}

export function encodeSubmissionMeta(params: {
  kind: H5UploadKind;
  scene: string;
  note?: string | null;
}): string {
  const header = [
    "__meta__:",
    `kind=${encodeURIComponent(params.kind)}`,
    `scene=${encodeURIComponent(params.scene)}`,
  ].join("");
  const note = params.note?.trim();
  return note ? `${header}\n${note}` : header;
}

function buildTips(kind: H5UploadKind): string[] {
  const common = [
    "请先选择本次拍摄场景，再上传视频。",
    "建议使用第一视角拍摄，画面尽量保持稳定。",
    "重点展示手部动作，双手尽量持续出镜。",
    "上传时间可能较长，请保持网络稳定，不要关闭页面。",
  ];

  if (kind === "test") {
    return [
      "测试视频仅用于审核拍摄质量，不计收益。",
      "测试视频建议时长不少于 10 分钟。",
      ...common,
    ];
  }

  return [
    "正式视频会进入审核流程，审核结果会在页面中展示。",
    ...common,
  ];
}

export function deriveWorkflowState(
  participant: ParticipantRow,
  submissions: VideoSubmissionRow[],
): DerivedWorkflowState {
  const workflow = parseParticipantWorkflowRow(participant);

  let testStatus = workflow.test_status;
  let formalStatus = workflow.formal_status;
  const consentConfirmed = workflow.consent_confirmed;

  for (const submission of submissions) {
    const inferredKind =
      submission.submission_type ??
      parseSubmissionMeta(submission.user_comment).kind ??
      (testStatus === "not_started" && formalStatus === "not_started" ? "test" : null);

    if (inferredKind === "test") {
      if (submission.review_status === "approved") {
        testStatus = "passed";
      } else if (submission.review_status === "rejected" && testStatus !== "passed") {
        testStatus = "failed";
      } else if (submission.review_status === "pending" && testStatus === "not_started") {
        testStatus = "pending";
      }
    }

    if (inferredKind === "formal") {
      if (submission.review_status === "pending" && formalStatus === "not_started") {
        formalStatus = "pending";
      } else if (submission.review_status === "approved" || submission.review_status === "rejected") {
        formalStatus = "reviewed";
      }
    }
  }

  if (!consentConfirmed) {
    return {
      consent_confirmed: consentConfirmed,
      test_status: testStatus,
      formal_status: formalStatus,
      stage: "new_unconfirmed",
      current_upload_kind: null,
      current_title: "请先在公众号完成参与确认",
      current_description: "你还没有完成“我同意”确认。完成后，这个页面会自动进入测试视频上传。",
      can_upload: false,
      tips: buildTips("test"),
    };
  }

  if (testStatus === "not_started") {
    return {
      consent_confirmed: consentConfirmed,
      test_status: testStatus,
      formal_status: formalStatus,
      stage: "test_pending_start",
      current_upload_kind: "test",
      current_title: "先提交测试视频",
      current_description: "首次参与请先提交 1 条测试视频。测试通过后，这个同一页面会自动切换为正式任务。",
      can_upload: true,
      tips: buildTips("test"),
    };
  }

  if (testStatus === "pending") {
    return {
      consent_confirmed: consentConfirmed,
      test_status: testStatus,
      formal_status: formalStatus,
      stage: "test_uploaded_pending_review",
      current_upload_kind: "test",
      current_title: "测试视频审核中",
      current_description: "你的测试视频已经提交成功，当前正在审核。审核通过后，这个页面会自动进入正式任务。",
      can_upload: true,
      tips: buildTips("test"),
    };
  }

  if (testStatus === "failed") {
    return {
      consent_confirmed: consentConfirmed,
      test_status: testStatus,
      formal_status: formalStatus,
      stage: "test_failed",
      current_upload_kind: "test",
      current_title: "请重新提交测试视频",
      current_description: "上一次测试未通过。请根据提示重新拍摄后，在这个页面继续上传测试视频。",
      can_upload: true,
      tips: buildTips("test"),
    };
  }

  if (formalStatus === "pending") {
    return {
      consent_confirmed: consentConfirmed,
      test_status: testStatus,
      formal_status: formalStatus,
      stage: "formal_uploaded_pending_review",
      current_upload_kind: "formal",
      current_title: "正式视频审核中",
      current_description: "你已经进入正式任务阶段，最近一次正式视频正在审核中。你也可以继续上传新的正式视频。",
      can_upload: true,
      tips: buildTips("formal"),
    };
  }

  return {
    consent_confirmed: consentConfirmed,
    test_status: testStatus,
    formal_status: formalStatus,
    stage: "formal_available",
    current_upload_kind: "formal",
    current_title: "现在开始正式任务",
    current_description: "测试已通过。请在这个同一页面选择场景并上传正式视频。",
    can_upload: true,
    tips: buildTips("formal"),
  };
}
