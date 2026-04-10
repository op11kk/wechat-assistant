import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { decorateSubmissionObjectUrl, REVIEW_STATUSES } from "@/lib/video-submissions";
import { getSupabaseAdmin } from "@/lib/supabase";

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
  let query = getSupabaseAdmin().from("video_submissions").select("*").order("id", { ascending: false }).limit(safeLimit);
  if (reviewStatus) {
    query = query.eq("review_status", reviewStatus);
  }
  const { data, error } = await query;
  if (error) {
    return jsonResponse({ error: "Query failed", detail: error.message }, 500);
  }
  return jsonResponse({
    submissions: (data ?? []).map((row) => decorateSubmissionObjectUrl(row)),
  });
}
