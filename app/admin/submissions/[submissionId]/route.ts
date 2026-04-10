import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { decorateSubmissionObjectUrl, REVIEW_STATUSES } from "@/lib/video-submissions";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

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

  const patch: Record<string, unknown> = {};
  if ("review_status" in body) {
    const reviewStatus = String(body.review_status ?? "").trim();
    if (!REVIEW_STATUSES.has(reviewStatus)) {
      return jsonResponse({ error: "invalid review_status" }, 400);
    }
    patch.review_status = reviewStatus;
    if (reviewStatus === "approved" || reviewStatus === "rejected") {
      patch.reviewed_at = new Date().toISOString();
    }
  }
  if ("reject_reason" in body) {
    patch.reject_reason = body.reject_reason;
  }
  if (Object.keys(patch).length === 0) {
    return jsonResponse({ error: "No patchable fields", detail: "review_status, reject_reason" }, 400);
  }

  const { data, error } = await getSupabaseAdmin()
    .from("video_submissions")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    return jsonResponse({ error: "Update failed", detail: error.message }, 500);
  }
  if (!data) {
    return jsonResponse({ error: "submission not found", hint: id }, 404);
  }
  return jsonResponse({
    message: "ok",
    submission: decorateSubmissionObjectUrl(data),
  });
}
