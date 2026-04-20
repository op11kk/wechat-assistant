import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { createParticipant, PARTICIPANT_STATUSES } from "@/lib/video-submissions";

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

  const createResult = await createParticipant({
    wechatOpenid,
    realName,
    phone,
    status,
    extra: extra && typeof extra === "object" ? (extra as Record<string, unknown>) : {},
  });

  if (createResult.status === "exists" && createResult.participant) {
    return jsonResponse(
      {
        error: "Participant already exists",
        participant: createResult.participant,
      },
      409,
    );
  }
  if (createResult.status === "created" && createResult.participant) {
    return jsonResponse({ message: "ok", participant: createResult.participant }, 201);
  }
  return jsonResponse(
    {
      error: "Failed to create participant",
      detail: createResult.detail ?? "unknown error",
    },
    500,
  );
}
