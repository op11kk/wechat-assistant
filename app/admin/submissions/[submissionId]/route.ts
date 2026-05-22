import { after, NextRequest } from "next/server";

import { logAdminAuditEvent } from "@/lib/admin-audit";
import { getCurrentAppUserFromRequest } from "@/lib/app-auth";
import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { buildReviewPatch, isReviewStatus, type ReviewStatus } from "@/lib/video-review-state";
import {
  decorateSubmissionObjectUrl,
  findParticipantById,
  getVideoSubmissionById,
  updateParticipantWorkflow,
  updateVideoSubmissionReview,
} from "@/lib/video-submissions";
import { sendWechatCustomTextMessage } from "@/lib/wechat";

export const runtime = "nodejs";

function buildReviewStatusMessage(params: {
  reviewStatus: "approved" | "rejected";
  rejectReason: string | null;
  uploadKind: "test" | "formal" | null;
}) {
  if (params.reviewStatus === "approved" && params.uploadKind === "test") {
    return "你的测试视频已通过审核。现在可以回复“开始”进入正式任务页面。";
  }
  if (params.reviewStatus === "approved") {
    return "你提交的视频已通过审核，感谢参与。";
  }
  if (params.rejectReason) {
    return `你提交的视频未通过审核。\n原因：${params.rejectReason}\n请根据提示调整后重新提交。`;
  }
  return "你提交的视频未通过审核，请回到 H5 页面查看最新状态并重新提交。";
}

async function syncParticipantWorkflowAfterReview(params: {
  participantId: number;
  uploadKind: "test" | "formal" | null;
  reviewStatus: "approved" | "rejected";
}) {
  if (params.uploadKind === "test") {
    await updateParticipantWorkflow(params.participantId, {
      consent_confirmed: true,
      test_status: params.reviewStatus === "approved" ? "passed" : "failed",
    });
    return;
  }

  if (params.uploadKind === "formal") {
    await updateParticipantWorkflow(params.participantId, {
      consent_confirmed: true,
      formal_status: "reviewed",
    });
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ submissionId: string }> },
) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { submissionId } = await context.params;
  const id = Number.parseInt(submissionId, 10);
  if (!Number.isFinite(id)) {
    return jsonResponse({ error: "invalid submission id" }, 400);
  }
  try {
    const data = await getVideoSubmissionById(id);
    if (!data) {
      return jsonResponse({ error: "submission not found", hint: id }, 404);
    }
    return jsonResponse({ submission: decorateSubmissionObjectUrl(data) });
  } catch (error) {
    return jsonResponse(
      { error: "Query failed", detail: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ submissionId: string }> },
) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { submissionId } = await context.params;
  const id = Number.parseInt(submissionId, 10);
  if (!Number.isFinite(id)) {
    return jsonResponse({ error: "invalid submission id" }, 400);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
    return jsonResponse({ error: "Invalid or empty JSON body" }, 400);
  }

  let reviewStatus: ReviewStatus | undefined;
  let rejectReason: string | null | undefined;

  if ("review_status" in body) {
    const rawReviewStatus = String(body.review_status ?? "").trim();
    if (!isReviewStatus(rawReviewStatus)) {
      return jsonResponse({ error: "invalid review_status" }, 400);
    }
    reviewStatus = rawReviewStatus;
  }

  if ("reject_reason" in body) {
    const rawRejectReason = body.reject_reason;
    if (rawRejectReason !== null && rawRejectReason !== undefined && typeof rawRejectReason !== "string") {
      return jsonResponse({ error: "reject_reason must be string or null" }, 400);
    }
    if (rawRejectReason === null || rawRejectReason === undefined || `${rawRejectReason}`.trim() === "") {
      rejectReason = null;
    } else {
      rejectReason = String(rawRejectReason).trim();
    }
  }

  if (reviewStatus === undefined && rejectReason === undefined) {
    return jsonResponse({ error: "No patchable fields", detail: "review_status, reject_reason" }, 400);
  }

  try {
    const current = await getVideoSubmissionById(id);
    if (!current) {
      return jsonResponse({ error: "submission not found", hint: id }, 404);
    }

    const reviewPatch = buildReviewPatch({
      currentStatus: current.review_status,
      nextStatus: reviewStatus,
      rejectReason,
    });
    if (!reviewPatch.ok) {
      return jsonResponse({ error: reviewPatch.error, detail: reviewPatch.detail }, 400);
    }

    const data = await updateVideoSubmissionReview({
      id,
      reviewStatus: reviewPatch.reviewStatus,
      rejectReason: reviewPatch.rejectReason,
      reviewedAt: reviewPatch.reviewedAt,
    });
    if (!data) {
      return jsonResponse({ error: "submission not found", hint: id }, 404);
    }

    const actor = await getCurrentAppUserFromRequest(request).catch(() => null);
    await logAdminAuditEvent({
      request,
      actor,
      action: "submission.review_update",
      targetType: "video_submission",
      targetId: id,
      targetLabel: data.participant_code,
      payload: {
        review_status: data.review_status,
        reject_reason: data.reject_reason,
        reviewed_at: data.reviewed_at,
      },
    });

    const finalReviewStatus = data.review_status;

    if (finalReviewStatus === "approved" || finalReviewStatus === "rejected") {
      await syncParticipantWorkflowAfterReview({
        participantId: data.participant_id,
        uploadKind: data.submission_type,
        reviewStatus: finalReviewStatus,
      });

      after(async () => {
        try {
          const participant = await findParticipantById(data.participant_id);
          if (!participant) {
            return;
          }
          const notifyResult = await sendWechatCustomTextMessage({
            openid: participant.wechat_openid,
            content: buildReviewStatusMessage({
              reviewStatus: finalReviewStatus,
              rejectReason: data.reject_reason,
              uploadKind: data.submission_type,
            }),
          });
          if (!notifyResult.ok) {
            console.warn("wechat review notification failed", notifyResult.detail);
          }
        } catch (error) {
          console.error("wechat review notification failed", error);
        }
      });
    }

    return jsonResponse({
      message: "ok",
      submission: decorateSubmissionObjectUrl(data),
    });
  } catch (error) {
    return jsonResponse(
      { error: "Update failed", detail: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}
