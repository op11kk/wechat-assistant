import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { decorateSubmissionObjectUrl, listVideoSubmissions, REVIEW_STATUSES } from "@/lib/video-submissions";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { searchParams } = new URL(request.url);
  const reviewStatus = searchParams.get("review_status")?.trim() ?? "";
  const limit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  if (!Number.isFinite(limit)) {
    return jsonResponse({ error: "limit must be integer" }, 400);
  }
  if (reviewStatus && !REVIEW_STATUSES.has(reviewStatus)) {
    return jsonResponse({ error: "invalid review_status" }, 400);
  }
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  try {
    const data = await listVideoSubmissions({
      reviewStatus: reviewStatus || undefined,
      limit: safeLimit,
    });
    return jsonResponse({
      submissions: data.map((row) => decorateSubmissionObjectUrl(row)),
    });
  } catch (error) {
    return jsonResponse(
      { error: "Query failed", detail: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}
