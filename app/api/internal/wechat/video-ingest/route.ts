import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { createChatVideoWechatSubmission } from "@/lib/video-submissions";

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

  const openid = String(body.openid ?? "").trim();
  const mediaId = String(body.media_id ?? "").trim();
  const userComment = body.user_comment == null ? null : String(body.user_comment);

  if (!openid || !mediaId) {
    return jsonResponse(
      {
        error: "Missing fields",
        detail: "openid and media_id are required",
      },
      400,
    );
  }

  try {
    const result = await createChatVideoWechatSubmission({
      openid,
      mediaId,
      userComment,
    });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        reason: "insert_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
