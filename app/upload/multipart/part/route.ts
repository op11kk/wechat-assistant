import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/http";
import { createPresignedUploadPartUrl } from "@/lib/r2";
import { getUploadSessionById, updateUploadSessionUploadedParts } from "@/lib/upload-sessions";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const sessionId = String(body.session_id ?? "").trim();
  const partNumber = Number.parseInt(String(body.part_number ?? ""), 10);
  if (!sessionId || !Number.isInteger(partNumber) || partNumber <= 0) {
    return jsonResponse({ error: "Missing fields", detail: "session_id and valid part_number required" }, 400);
  }

  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404);
    }
    if (session.status !== "uploading") {
      return jsonResponse({ error: "Upload session not active", detail: `status=${session.status}` }, 409);
    }
    if (partNumber > session.part_count) {
      return jsonResponse({ error: "part_number out of range" }, 400);
    }

    const part = await createPresignedUploadPartUrl({
      objectKey: session.object_key,
      uploadId: session.upload_id,
      partNumber,
    });
    return jsonResponse(part);
  } catch (error) {
    return jsonResponse({ error: "multipart part presign failed", detail: String(error) }, 500);
  }
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const sessionId = String(body.session_id ?? "").trim();
  const partNumber = Number.parseInt(String(body.part_number ?? ""), 10);
  const etag = String(body.etag ?? "").trim();
  if (!sessionId || !Number.isInteger(partNumber) || partNumber <= 0 || !etag) {
    return jsonResponse(
      { error: "Missing fields", detail: "session_id, valid part_number, etag required" },
      400,
    );
  }

  try {
    const session = await getUploadSessionById(sessionId);
    if (!session) {
      return jsonResponse({ error: "Upload session not found" }, 404);
    }
    const merged = new Map(session.uploaded_parts.map((part) => [part.part_number, part.etag]));
    merged.set(partNumber, etag);
    const updated = await updateUploadSessionUploadedParts(
      sessionId,
      Array.from(merged.entries()).map(([part_number, currentEtag]) => ({ part_number, etag: currentEtag })),
    );
    return jsonResponse({
      message: "ok",
      uploaded_parts: updated.uploaded_parts,
      uploaded_count: updated.uploaded_parts.length,
      part_count: updated.part_count,
    });
  } catch (error) {
    return jsonResponse({ error: "multipart part record failed", detail: String(error) }, 500);
  }
}
