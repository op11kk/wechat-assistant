import { NextRequest } from "next/server";

import { corsPreflightResponse, jsonResponse, withCorsHeaders } from "@/lib/http";
import { createPresignedUploadPartUrl } from "@/lib/r2";
import { getUploadSessionById, updateUploadSessionUploadedParts } from "@/lib/upload-sessions";

export const runtime = "nodejs";

export function OPTIONS(request: NextRequest) {
  return corsPreflightResponse(request.headers.get("origin"), "POST,PATCH,OPTIONS");
}

export async function POST(request: NextRequest) {
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "POST,PATCH,OPTIONS");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, { headers: corsHeaders });
  }

  const sessionId = String(body.session_id ?? "").trim();
  const partNumber = Number.parseInt(String(body.part_number ?? ""), 10);
  if (!sessionId || !Number.isInteger(partNumber) || partNumber <= 0) {
    return jsonResponse({ error: "Missing fields", detail: "session_id and valid part_number required" }, 400, {
      headers: corsHeaders,
    });
  }

  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404, { headers: corsHeaders });
    }
    if (session.status !== "uploading") {
      return jsonResponse({ error: "Upload session not active", detail: `status=${session.status}` }, 409, {
        headers: corsHeaders,
      });
    }
    if (partNumber > session.part_count) {
      return jsonResponse({ error: "part_number out of range" }, 400, { headers: corsHeaders });
    }

    const part = await createPresignedUploadPartUrl({
      objectKey: session.object_key,
      uploadId: session.upload_id,
      partNumber,
    });
    return jsonResponse(part, 200, { headers: corsHeaders });
  } catch (error) {
    return jsonResponse({ error: "multipart part presign failed", detail: String(error) }, 500, {
      headers: corsHeaders,
    });
  }
}

export async function PATCH(request: NextRequest) {
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "POST,PATCH,OPTIONS");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, { headers: corsHeaders });
  }

  const sessionId = String(body.session_id ?? "").trim();
  const partNumber = Number.parseInt(String(body.part_number ?? ""), 10);
  const etag = String(body.etag ?? "").trim();
  if (!sessionId || !Number.isInteger(partNumber) || partNumber <= 0 || !etag) {
    return jsonResponse(
      { error: "Missing fields", detail: "session_id, valid part_number, etag required" },
      400,
      { headers: corsHeaders },
    );
  }

  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404, { headers: corsHeaders });
    }
    const merged = new Map(session.uploaded_parts.map((part) => [part.part_number, part.etag]));
    merged.set(partNumber, etag);
    const updated = await updateUploadSessionUploadedParts(
      sessionId,
      Array.from(merged.entries()).map(([part_number, currentEtag]) => ({ part_number, etag: currentEtag })),
    );
    return jsonResponse(
      {
        message: "ok",
        uploaded_parts: updated.uploaded_parts,
        uploaded_count: updated.uploaded_parts.length,
        part_count: updated.part_count,
      },
      200,
      { headers: corsHeaders },
    );
  } catch (error) {
    return jsonResponse({ error: "multipart part record failed", detail: String(error) }, 500, {
      headers: corsHeaders,
    });
  }
}
