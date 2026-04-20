import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import {
  decorateSubmissionObjectUrl,
  getVideoSubmissionById,
  REVIEW_STATUSES,
  updateVideoSubmissionReview,
} from "@/lib/video-submissions";

export const runtime = "nodejs";

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

  let reviewStatus: "pending" | "approved" | "rejected" | undefined;
  let rejectReason: string | null | undefined;
  let reviewedAt: string | null | undefined;
  if ("review_status" in body) {
    const rawReviewStatus = String(body.review_status ?? "").trim();
    if (!REVIEW_STATUSES.has(rawReviewStatus)) {
      return jsonResponse({ error: "invalid review_status" }, 400);
    }
    reviewStatus = rawReviewStatus as typeof reviewStatus;
    if (reviewStatus === "approved" || reviewStatus === "rejected") {
      reviewedAt = new Date().toISOString();
    }
  }
  if ("reject_reason" in body) {
    const rr = body.reject_reason;
    if (rr !== null && rr !== undefined && typeof rr !== "string") {
      return jsonResponse({ error: "reject_reason must be string or null" }, 400);
    }
    if (rr === null || rr === undefined || `${rr}`.trim() === "") {
      rejectReason = null;
    } else {
      rejectReason = String(rr).trim();
    }
  }
  if (reviewStatus === undefined && rejectReason === undefined && reviewedAt === undefined) {
    return jsonResponse({ error: "No patchable fields", detail: "review_status, reject_reason" }, 400);
  }

  try {
    const data = await updateVideoSubmissionReview({
      id,
      reviewStatus,
      rejectReason,
      reviewedAt,
    });
    if (!data) {
      return jsonResponse({ error: "submission not found", hint: id }, 404);
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
