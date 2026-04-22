import { NextRequest } from "next/server";

import { hasBackendProxyOrigin, proxyToBackend } from "@/lib/backend-proxy";
import { corsPreflightResponse, jsonResponse, withCorsHeaders } from "@/lib/http";
import { abortMultipartUpload } from "@/lib/r2";
import { getUploadSessionById, updateUploadSessionStatus } from "@/lib/upload-sessions";

export const runtime = "nodejs";

type Params = {
  params: Promise<{
    sessionId: string;
  }>;
};

export function OPTIONS(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  return corsPreflightResponse(request.headers.get("origin"), "GET,DELETE,OPTIONS");
}

export async function GET(request: NextRequest, context: Params) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "GET,DELETE,OPTIONS");
  const { sessionId } = await context.params;
  if (!sessionId) {
    return jsonResponse({ error: "sessionId required" }, 400, { headers: corsHeaders });
  }
  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404, { headers: corsHeaders });
    }
    return jsonResponse(
      {
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
      },
      200,
      { headers: corsHeaders },
    );
  } catch (error) {
    return jsonResponse({ error: "upload session lookup failed", detail: String(error) }, 500, {
      headers: corsHeaders,
    });
  }
}

export async function DELETE(request: NextRequest, context: Params) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "GET,DELETE,OPTIONS");
  const { sessionId } = await context.params;
  if (!sessionId) {
    return jsonResponse({ error: "sessionId required" }, 400, { headers: corsHeaders });
  }
  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404, { headers: corsHeaders });
    }
    if (session.status === "completed") {
      return jsonResponse({ error: "Completed sessions cannot be aborted" }, 409, { headers: corsHeaders });
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
    return jsonResponse({ message: "ok", status: "aborted" }, 200, { headers: corsHeaders });
  } catch (error) {
    return jsonResponse({ error: "abort upload failed", detail: String(error) }, 500, { headers: corsHeaders });
  }
}
