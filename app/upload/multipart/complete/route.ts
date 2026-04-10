import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { hasObjectStorageConfig } from "@/lib/env";
import { jsonResponse } from "@/lib/http";
import { s3CompleteMultipartUpload } from "@/lib/r2";
import {
  decodeAndVerifySessionToken,
  getMultipartSigningSecret,
  MULTIPART_PART_SIZE_BYTES,
} from "@/lib/upload-multipart-session";
import {
  decorateSubmissionObjectUrl,
  findParticipantByCodeAndOpenId,
  insertVideoSubmissionRow,
} from "@/lib/video-submissions";

export const runtime = "nodejs";
export const maxDuration = 120;

type PartEntry = { PartNumber?: unknown; ETag?: unknown };

export async function POST(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const signingSecret = getMultipartSigningSecret();
  if (!signingSecret) {
    return jsonResponse({ error: "Multipart signing not configured" }, 503);
  }
  if (!hasObjectStorageConfig()) {
    return jsonResponse({ error: "Object storage not configured" }, 503);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const sessionToken = String(body.session_token ?? "").trim();
  const partsRaw = body.parts;
  if (!sessionToken || !Array.isArray(partsRaw) || partsRaw.length === 0) {
    return jsonResponse({ error: "session_token and non-empty parts[] required" }, 400);
  }

  const verified = decodeAndVerifySessionToken(sessionToken, signingSecret);
  if (!verified.ok) {
    return jsonResponse({ error: "Invalid session", detail: verified.error }, 403);
  }
  const session = verified.payload;

  const parts: { PartNumber: number; ETag: string }[] = [];
  for (const row of partsRaw as PartEntry[]) {
    const pn = Number(row.PartNumber);
    const etag = row.ETag != null ? String(row.ETag) : "";
    if (!Number.isFinite(pn) || pn < 1 || !etag) {
      return jsonResponse({ error: "Each part needs PartNumber and ETag" }, 400);
    }
    parts.push({ PartNumber: pn, ETag: etag });
  }

  const totalParts = Math.ceil(session.totalSize / MULTIPART_PART_SIZE_BYTES);
  if (parts.length !== totalParts) {
    return jsonResponse(
      { error: "Part count mismatch", detail: `Expected ${totalParts} parts, got ${parts.length}` },
      400,
    );
  }

  let participant;
  try {
    participant = await findParticipantByCodeAndOpenId(session.participantCode, session.wechatOpenid);
  } catch (error) {
    return jsonResponse({ error: "Query failed", detail: String(error) }, 500);
  }
  if (!participant || participant.status !== "active") {
    return jsonResponse({ error: "Participant not allowed" }, 403);
  }

  try {
    await s3CompleteMultipartUpload({
      objectKey: session.objectKey,
      uploadId: session.uploadId,
      parts,
    });
  } catch (error) {
    console.error("CompleteMultipartUpload failed", error);
    return jsonResponse({ error: "CompleteMultipartUpload failed", detail: String(error) }, 502);
  }

  const userCommentRaw = body.user_comment;
  const userComment =
    userCommentRaw !== undefined && userCommentRaw !== null && String(userCommentRaw).trim() !== ""
      ? String(userCommentRaw).trim()
      : null;

  const insertResult = await insertVideoSubmissionRow({
    participant_id: participant.id,
    participant_code: session.participantCode,
    source: "h5",
    object_key: session.objectKey,
    file_name: session.fileName,
    size_bytes: session.totalSize,
    mime: session.contentType,
    user_comment: userComment,
    review_status: "pending",
  });

  if (insertResult.status !== "inserted" || !insertResult.submission) {
    return jsonResponse(
      {
        error: "DB insert failed",
        detail: insertResult.detail ?? insertResult.status,
        object_key: session.objectKey,
      },
      500,
    );
  }

  return jsonResponse({
    message: "ok",
    object_key: session.objectKey,
    submission: decorateSubmissionObjectUrl(insertResult.submission),
    via: "server_proxy_multipart",
    hint: "超大文件仍建议配置 COS CORS 使用浏览器直传，减轻 Vercel 耗时与费用。",
  });
}
