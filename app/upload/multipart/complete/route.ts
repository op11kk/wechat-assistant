import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/http";
import { completeMultipartUpload } from "@/lib/r2";
import { getUploadSessionById, updateUploadSessionStatus, updateUploadSessionUploadedParts } from "@/lib/upload-sessions";
import {
  decorateSubmissionObjectUrl,
  findExistingSubmissionForDedup,
  insertVideoSubmissionRow,
} from "@/lib/video-submissions";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const sessionId = String(body.session_id ?? "").trim();
  const userComment = String(body.user_comment ?? "").trim() || null;
  const parts = Array.isArray(body.parts)
    ? body.parts
        .map((part) => ({
          part_number: Number.parseInt(String((part as { part_number?: unknown }).part_number ?? ""), 10),
          etag: String((part as { etag?: unknown }).etag ?? "").trim(),
        }))
        .filter((part) => Number.isInteger(part.part_number) && part.part_number > 0 && part.etag)
    : [];

  if (!sessionId) {
    return jsonResponse({ error: "Missing fields", detail: "session_id required" }, 400);
  }

  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404);
    }
    if (session.status === "completed") {
      const existing = await findExistingSubmissionForDedup({
        participantId: session.participant_id,
        objectKey: session.object_key,
      });
      if (existing) {
        return jsonResponse(
          { message: "ok", submission: decorateSubmissionObjectUrl(existing), deduplicated: true },
          200,
        );
      }
    }
    if (session.status !== "uploading") {
      return jsonResponse({ error: "Upload session not active", detail: `status=${session.status}` }, 409);
    }

    const finalParts = parts.length > 0 ? parts : session.uploaded_parts;
    if (finalParts.length === 0 || finalParts.length !== session.part_count) {
      return jsonResponse(
        {
          error: "Missing uploaded parts",
          detail: `expected ${session.part_count} parts, got ${finalParts.length}`,
        },
        400,
      );
    }

    await updateUploadSessionUploadedParts(sessionId, finalParts);
    await completeMultipartUpload({
      objectKey: session.object_key,
      uploadId: session.upload_id,
      parts: finalParts,
    });

    const insertResult = await insertVideoSubmissionRow({
      participant_id: session.participant_id,
      participant_code: session.participant_code,
      source: "h5",
      object_key: session.object_key,
      file_name: session.file_name,
      size_bytes: session.size_bytes,
      mime: session.mime,
      user_comment: userComment ?? session.user_comment,
      review_status: "pending",
    });

    if (insertResult.status === "inserted" && insertResult.submission) {
      await updateUploadSessionStatus({
        sessionId,
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      return jsonResponse(
        { message: "ok", submission: decorateSubmissionObjectUrl(insertResult.submission) },
        201,
      );
    }

    if (insertResult.status === "duplicate") {
      const existing = await findExistingSubmissionForDedup({
        participantId: session.participant_id,
        objectKey: session.object_key,
      });
      await updateUploadSessionStatus({
        sessionId,
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      return jsonResponse(
        {
          message: "ok",
          submission: existing ? decorateSubmissionObjectUrl(existing) : null,
          deduplicated: true,
        },
        200,
      );
    }

    await updateUploadSessionStatus({
      sessionId,
      status: "failed",
      errorMessage: insertResult.detail ?? "Failed to insert submission",
    });
    return jsonResponse(
      {
        error: "Failed to insert submission",
        detail: insertResult.detail ?? "unknown error",
      },
      500,
    );
  } catch (error) {
    return jsonResponse({ error: "multipart complete failed", detail: String(error) }, 500);
  }
}
