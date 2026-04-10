import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import {
  decorateSubmissionObjectUrl,
  findExistingSubmissionForDedup,
  findParticipantByCodeAndOpenId,
  insertVideoSubmissionRow,
  SUBMISSION_SOURCES,
} from "@/lib/video-submissions";

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
  const required = ["participant_code", "wechat_openid", "source", "object_key"] as const;
  const missing = required.filter((field) => !String(body[field] ?? "").trim());
  if (missing.length > 0) {
    return jsonResponse({ error: "Missing fields", detail: missing.join(", ") }, 400);
  }

  const participantCode = String(body.participant_code).trim();
  const wechatOpenid = String(body.wechat_openid).trim();
  const source = String(body.source).trim().toLowerCase();
  const objectKey = String(body.object_key).trim();
  if (!SUBMISSION_SOURCES.has(source)) {
    return jsonResponse({ error: "source must be chat or h5" }, 400);
  }

  const sizeBytesRaw = body.size_bytes;
  let sizeBytes: number | null = null;
  if (sizeBytesRaw !== undefined && sizeBytesRaw !== null && `${sizeBytesRaw}`.trim() !== "") {
    sizeBytes = Number.parseInt(String(sizeBytesRaw), 10);
    if (!Number.isFinite(sizeBytes)) {
      return jsonResponse({ error: "size_bytes must be integer" }, 400);
    }
  }

  const durationRaw = body.duration_sec;
  let durationSec: number | null = null;
  if (durationRaw !== undefined && durationRaw !== null && `${durationRaw}`.trim() !== "") {
    durationSec = Number.parseFloat(String(durationRaw));
    if (!Number.isFinite(durationSec)) {
      return jsonResponse({ error: "duration_sec must be numeric" }, 400);
    }
  }

  try {
    const participant = await findParticipantByCodeAndOpenId(participantCode, wechatOpenid);
    if (!participant) {
      return jsonResponse(
        {
          error: "Participant mismatch",
          detail: "No row for this participant_code and wechat_openid",
        },
        404,
      );
    }

    const payload = {
      participant_id: participant.id,
      participant_code: participantCode,
      source,
      object_key: objectKey,
      wechat_media_id: body.wechat_media_id ? String(body.wechat_media_id).trim() : null,
      file_name: body.file_name ? String(body.file_name).trim() : null,
      size_bytes: sizeBytes,
      mime: body.mime ? String(body.mime).trim() : null,
      duration_sec: durationSec,
      user_comment: body.user_comment ? String(body.user_comment).trim() : null,
      review_status: "pending" as const,
    };

    if (!payload.wechat_media_id) {
      const existing = await findExistingSubmissionForDedup({
        participantId: participant.id,
        objectKey,
      });
      if (existing) {
        return jsonResponse(
          { message: "ok", submission: decorateSubmissionObjectUrl(existing), deduplicated: true },
          200,
        );
      }
    }

    const insertResult = await insertVideoSubmissionRow(payload);
    if (insertResult.status === "inserted" && insertResult.submission) {
      return jsonResponse({ message: "ok", submission: decorateSubmissionObjectUrl(insertResult.submission) }, 201);
    }
    if (insertResult.status === "duplicate") {
      const existing = await findExistingSubmissionForDedup({
        participantId: participant.id,
        objectKey,
        wechatMediaId: payload.wechat_media_id,
      });
      if (existing) {
        return jsonResponse(
          { message: "ok", submission: decorateSubmissionObjectUrl(existing), deduplicated: true },
          200,
        );
      }
      return jsonResponse({ message: "ok", deduplicated: true }, 200);
    }
    return jsonResponse(
      {
        error: "Failed to insert submission",
        detail: insertResult.detail ?? "unknown error",
      },
      500,
    );
  } catch (error) {
    return jsonResponse({ error: "upload/complete failed", detail: String(error) }, 500);
  }
}
