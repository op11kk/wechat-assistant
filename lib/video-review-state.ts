export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_SET: ReadonlySet<string> = new Set(REVIEW_STATUSES);

export type ReviewLifecycleStage =
  | "uploaded"
  | "ai_pending"
  | "manual_pending"
  | "approved"
  | "rejected";

export function isReviewStatus(value: string): value is ReviewStatus {
  return REVIEW_STATUS_SET.has(value);
}

export function getReviewLifecycleStage(params: {
  reviewStatus: ReviewStatus;
  analysisStatus?: string | null;
}): ReviewLifecycleStage {
  if (params.reviewStatus === "approved") {
    return "approved";
  }

  if (params.reviewStatus === "rejected") {
    return "rejected";
  }

  if (!params.analysisStatus || params.analysisStatus === "pending" || params.analysisStatus === "queued") {
    return "ai_pending";
  }

  return "manual_pending";
}

export function buildReviewPatch(params: {
  currentStatus: ReviewStatus;
  nextStatus?: ReviewStatus;
  rejectReason?: string | null;
  now?: string;
}):
  | {
      ok: true;
      reviewStatus?: ReviewStatus;
      rejectReason?: string | null;
      reviewedAt?: string | null;
    }
  | { ok: false; error: string; detail: string } {
  const now = params.now ?? new Date().toISOString();
  const nextStatus = params.nextStatus;
  const normalizedRejectReason = params.rejectReason?.trim() ?? "";

  if (!nextStatus) {
    return {
      ok: true,
      rejectReason: params.rejectReason,
    };
  }

  if (nextStatus === "rejected" && !normalizedRejectReason) {
    return {
      ok: false,
      error: "reject_reason_required",
      detail: "驳回视频时必须填写驳回原因，方便采集员重新提交。",
    };
  }

  if (nextStatus === "pending") {
    return {
      ok: true,
      reviewStatus: "pending",
      rejectReason: null,
      reviewedAt: null,
    };
  }

  if (nextStatus === "approved") {
    return {
      ok: true,
      reviewStatus: "approved",
      rejectReason: null,
      reviewedAt: now,
    };
  }

  return {
    ok: true,
    reviewStatus: "rejected",
    rejectReason: normalizedRejectReason,
    reviewedAt: now,
  };
}
