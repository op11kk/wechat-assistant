import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { hasR2Config } from "@/lib/env";
import { jsonResponse } from "@/lib/http";
import { buildH5ObjectKey, createPresignedUploadUrl } from "@/lib/r2";
import { findParticipantByCodeAndOpenId } from "@/lib/video-submissions";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  if (!hasR2Config()) {
    return jsonResponse(
      {
        error: "Cloudflare R2 not configured",
        detail:
          "CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY and CLOUDFLARE_R2_BUCKET are required.",
      },
      503,
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const participantCode = String(body.participant_code ?? "").trim();
  const wechatOpenid = String(body.wechat_openid ?? "").trim();
  const contentType = String(body.content_type ?? "video/mp4").trim() || "video/mp4";
  const fileName = String(body.file_name ?? "").trim() || null;

  if (!participantCode || !wechatOpenid) {
    return jsonResponse(
      {
        error: "Missing fields",
        detail: "participant_code, wechat_openid required",
      },
      400,
    );
  }

  try {
    const participant = await findParticipantByCodeAndOpenId(participantCode, wechatOpenid);
    if (!participant) {
      return jsonResponse(
        {
          error: "Participant mismatch",
          detail: "No row for this participant_code and wechat_openid. Please register first.",
        },
        404,
      );
    }

    const objectKey = buildH5ObjectKey(participantCode, fileName, contentType);
    const presign = await createPresignedUploadUrl({
      objectKey,
      contentType,
    });
    return jsonResponse(presign);
  } catch (error) {
    return jsonResponse({ error: "presign failed", detail: String(error) }, 500);
  }
}
