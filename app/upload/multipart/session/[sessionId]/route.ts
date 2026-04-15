import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/http";
import { abortMultipartUpload } from "@/lib/r2";
import { getUploadSessionById, updateUploadSessionStatus } from "@/lib/upload-sessions";

export const runtime = "nodejs";

type Params = {
  params: Promise<{
    sessionId: string;
  }>;
};

export async function GET(_request: NextRequest, context: Params) {
  const { sessionId } = await context.params;
  if (!sessionId) {
    return jsonResponse({ error: "sessionId required" }, 400);
  }
  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404);
    }
    return jsonResponse({
      session_id: session.id,
      status: session.status,
      object_key: session.object_key,
      file_name: session.file_name,
      size_bytes: session.size_bytes,
      mime: session.mime,
      part_size: session.part_size,
      part_count: session.part_count,
      uploaded_parts: session.uploaded_parts,
      user_comment: session.user_comment,
      created_at: session.created_at,
      updated_at: session.updated_at,
      completed_at: session.completed_at,
    });
  } catch (error) {
    return jsonResponse({ error: "upload session lookup failed", detail: String(error) }, 500);
  }
}

export async function DELETE(_request: NextRequest, context: Params) {
  const { sessionId } = await context.params;
  if (!sessionId) {
    return jsonResponse({ error: "sessionId required" }, 400);
  }
  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404);
    }
    if (session.status === "completed") {
      return jsonResponse({ error: "Completed sessions cannot be aborted" }, 409);
    }
    await abortMultipartUpload({
      objectKey: session.object_key,
      uploadId: session.upload_id,
    });
    await updateUploadSessionStatus({
      sessionId,
      status: "aborted",
      errorMessage: null,
    });
    return jsonResponse({ message: "ok", status: "aborted" });
  } catch (error) {
    return jsonResponse({ error: "abort upload failed", detail: String(error) }, 500);
  }
}
