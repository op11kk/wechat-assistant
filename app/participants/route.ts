import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse, isDuplicateError } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";
import { nextParticipantCode, PARTICIPANT_STATUSES } from "@/lib/video-submissions";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const wechatOpenid = String(body.wechat_openid ?? "").trim();
  const realName = String(body.real_name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const status = String(body.status ?? "active").trim() || "active";
  const extra = body.extra;

  if (!wechatOpenid || !realName || !phone) {
    return jsonResponse(
      {
        error: "Missing fields",
        detail: "wechat_openid, real_name, phone required",
      },
      400,
    );
  }
  if (!PARTICIPANT_STATUSES.has(status)) {
    return jsonResponse({ error: "invalid status" }, 400);
  }
  if (extra !== undefined && (typeof extra !== "object" || extra === null || Array.isArray(extra))) {
    return jsonResponse({ error: "extra must be an object" }, 400);
  }

  const existing = await getSupabaseAdmin()
    .from("participants")
    .select("*")
    .eq("wechat_openid", wechatOpenid)
    .maybeSingle();
  if (existing.error) {
    return jsonResponse({ error: "Query failed", detail: existing.error.message }, 500);
  }
  if (existing.data) {
    return jsonResponse(
      {
        error: "Participant already exists",
        participant: existing.data,
      },
      409,
    );
  }

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const participantCode = await nextParticipantCode();
    const insertResult = await getSupabaseAdmin()
      .from("participants")
      .insert({
        wechat_openid: wechatOpenid,
        real_name: realName,
        phone,
        participant_code: participantCode,
        status,
        extra: extra && typeof extra === "object" ? extra : {},
      })
      .select("*")
      .single();
    if (!insertResult.error && insertResult.data) {
      return jsonResponse({ message: "ok", participant: insertResult.data }, 201);
    }
    if (!isDuplicateError(insertResult.error)) {
      return jsonResponse(
        {
          error: "Failed to create participant",
          detail: insertResult.error?.message ?? "unknown error",
        },
        500,
      );
    }
  }

  return jsonResponse({ error: "Could not allocate participant_code" }, 500);
}
