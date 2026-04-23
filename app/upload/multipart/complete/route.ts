import { after, NextRequest } from "next/server";

import { hasBackendProxyOrigin, proxyToBackend } from "@/lib/backend-proxy";
import { parseSubmissionMeta } from "@/lib/h5-workflow";
import { corsPreflightResponse, jsonResponse, withCorsHeaders } from "@/lib/http";
import { completeMultipartUpload } from "@/lib/r2";
import { getUploadSessionById, updateUploadSessionStatus, updateUploadSessionUploadedParts } from "@/lib/upload-sessions";
import {
  decorateSubmissionObjectUrl,
  findExistingSubmissionForDedup,
  findParticipantById,
  insertVideoSubmissionRow,
  updateParticipantWorkflow,
} from "@/lib/video-submissions";
import { sendWechatCustomTextMessage } from "@/lib/wechat";

export const runtime = "nodejs";

export function OPTIONS(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  return corsPreflightResponse(request.headers.get("origin"), "POST,OPTIONS");
}

function buildUploadSuccessMessage(params: {
  fileName: string | null;
  uploadKind: "test" | "formal" | null;
}) {
  const lines =
    params.uploadKind === "test"
      ? ["你的测试视频已收到，当前状态为“待审核”。审核通过后，同一个 H5 页面会自动切换为正式任务。"]
      : ["你的视频已收到，当前状态为“待审核”。"];

  if (params.fileName) {
    lines.push(`文件：${params.fileName}`);
  }
  lines.push("你可以回到 H5 页面查看最新审核状态。");
  return lines.join("\n");
}

async function syncParticipantWorkflowAfterUpload(params: {
  participantId: number;
  uploadKind: "test" | "formal" | null;
}) {
  if (params.uploadKind === "test") {
    await updateParticipantWorkflow(params.participantId, {
      consent_confirmed: true,
      test_status: "pending",
    });
    return;
  }

  if (params.uploadKind === "formal") {
    await updateParticipantWorkflow(params.participantId, {
      consent_confirmed: true,
      formal_status: "pending",
    });
  }
}

export async function POST(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "POST,OPTIONS");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, { headers: corsHeaders });
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
    return jsonResponse({ error: "Missing fields", detail: "session_id required" }, 400, { headers: corsHeaders });
  }

  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404, { headers: corsHeaders });
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
          { headers: corsHeaders },
        );
      }
    }
    if (session.status !== "uploading") {
      return jsonResponse({ error: "Upload session not active", detail: `status=${session.status}` }, 409, {
        headers: corsHeaders,
      });
    }

    const finalParts = parts.length > 0 ? parts : session.uploaded_parts;
    if (finalParts.length === 0 || finalParts.length !== session.part_count) {
      return jsonResponse(
        {
          error: "Missing uploaded parts",
          detail: `expected ${session.part_count} parts, got ${finalParts.length}`,
        },
        400,
        { headers: corsHeaders },
      );
    }

    await updateUploadSessionUploadedParts(sessionId, finalParts);
    await completeMultipartUpload({
      objectKey: session.object_key,
      uploadId: session.upload_id,
      parts: finalParts,
    });

    const finalComment = userComment ?? session.user_comment;
    const submissionMeta = parseSubmissionMeta(finalComment);

    const insertResult = await insertVideoSubmissionRow({
      participant_id: session.participant_id,
      participant_code: session.participant_code,
      source: "h5",
      object_key: session.object_key,
      file_name: session.file_name,
      size_bytes: session.size_bytes,
      mime: session.mime,
      user_comment: submissionMeta.note,
      submission_type: submissionMeta.kind,
      scene: submissionMeta.scene,
      review_status: "pending",
    });

    if (insertResult.status === "inserted" && insertResult.submission) {
      await updateUploadSessionStatus({
        sessionId,
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      await syncParticipantWorkflowAfterUpload({
        participantId: insertResult.submission.participant_id,
        uploadKind: submissionMeta.kind,
      });

      const submission = insertResult.submission;
      const decorated = decorateSubmissionObjectUrl(submission);

      after(async () => {
        try {
          const participant = await findParticipantById(submission.participant_id);
          if (!participant) {
            return;
          }
          const notifyResult = await sendWechatCustomTextMessage({
            openid: participant.wechat_openid,
            content: buildUploadSuccessMessage({
              fileName: decorated.file_name,
              uploadKind: submissionMeta.kind,
            }),
          });
          if (!notifyResult.ok) {
            console.warn("wechat upload success notification failed", notifyResult.detail);
          }
        } catch (error) {
          console.error("wechat upload success notification failed", error);
        }
      });

      return jsonResponse({ message: "ok", submission: decorated }, 201, { headers: corsHeaders });
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
        { headers: corsHeaders },
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
      { headers: corsHeaders },
    );
  } catch (error) {
    return jsonResponse({ error: "multipart complete failed", detail: String(error) }, 500, {
      headers: corsHeaders,
    });
  }
}
