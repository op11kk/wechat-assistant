import { NextRequest } from "next/server";

import { hasBackendProxyOrigin, proxyToBackend } from "@/lib/backend-proxy";
import { corsPreflightResponse, jsonResponse, withCorsHeaders } from "@/lib/http";
import { createPresignedUploadPartUrl } from "@/lib/r2";
import {
  getUploadSessionById,
  mergeUploadSessionUploadedPart,
  mergeUploadSessionUploadedParts,
} from "@/lib/upload-sessions";

export const runtime = "nodejs";

function normalizePartNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => Number.parseInt(String(item ?? ""), 10))
        .filter((partNumber) => Number.isInteger(partNumber) && partNumber > 0),
    ),
  ).sort((a, b) => a - b);
}

function normalizeUploadedParts(
  value: unknown,
): Array<{
  part_number: number;
  etag: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  const parts = new Map<number, string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const partNumber = Number.parseInt(String((item as { part_number?: unknown }).part_number ?? ""), 10);
    const etag = String((item as { etag?: unknown }).etag ?? "").trim();
    if (!Number.isInteger(partNumber) || partNumber <= 0 || !etag) {
      continue;
    }

    parts.set(partNumber, etag);
  }

  return Array.from(parts.entries())
    .sort(([a], [b]) => a - b)
    .map(([part_number, etag]) => ({ part_number, etag }));
}

export function OPTIONS(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  return corsPreflightResponse(request.headers.get("origin"), "POST,PATCH,OPTIONS");
}

export async function POST(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "POST,PATCH,OPTIONS");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, { headers: corsHeaders });
  }

  const sessionId = String(body.session_id ?? "").trim();
  const requestedPartNumbers = normalizePartNumbers(body.part_numbers);
  const singlePartNumber = Number.parseInt(String(body.part_number ?? ""), 10);
  const partNumbers =
    requestedPartNumbers.length > 0
      ? requestedPartNumbers
      : Number.isInteger(singlePartNumber) && singlePartNumber > 0
        ? [singlePartNumber]
        : [];
  if (!sessionId || partNumbers.length === 0) {
    return jsonResponse(
      { error: "Missing fields", detail: "session_id and valid part_number or part_numbers required" },
      400,
      {
        headers: corsHeaders,
      },
    );
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
    if (partNumbers.some((partNumber) => partNumber > session.part_count)) {
      return jsonResponse({ error: "part_number out of range" }, 400, { headers: corsHeaders });
    }

    const presignedParts = await Promise.all(
      partNumbers.map((partNumber) =>
        createPresignedUploadPartUrl({
          objectKey: session.object_key,
          uploadId: session.upload_id,
          partNumber,
        }),
      ),
    );

    if (requestedPartNumbers.length > 0) {
      return jsonResponse(
        {
          session_id: session.id,
          parts: presignedParts,
        },
        200,
        { headers: corsHeaders },
      );
    }

    return jsonResponse(presignedParts[0], 200, { headers: corsHeaders });
  } catch (error) {
    return jsonResponse({ error: "multipart part presign failed", detail: String(error) }, 500, {
      headers: corsHeaders,
    });
  }
}

export async function PATCH(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "POST,PATCH,OPTIONS");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, { headers: corsHeaders });
  }

  const sessionId = String(body.session_id ?? "").trim();
  const singlePartNumber = Number.parseInt(String(body.part_number ?? ""), 10);
  const singleEtag = String(body.etag ?? "").trim();
  const batchParts = normalizeUploadedParts(body.parts);
  const uploadedParts =
    batchParts.length > 0
      ? batchParts
      : Number.isInteger(singlePartNumber) && singlePartNumber > 0 && singleEtag
        ? [{ part_number: singlePartNumber, etag: singleEtag }]
        : [];
  if (!sessionId || uploadedParts.length === 0) {
    return jsonResponse(
      { error: "Missing fields", detail: "session_id and uploaded parts required" },
      400,
      { headers: corsHeaders },
    );
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
    if (uploadedParts.some((part) => part.part_number > session.part_count)) {
      return jsonResponse({ error: "part_number out of range" }, 400, { headers: corsHeaders });
    }

    const updated =
      uploadedParts.length === 1
        ? await mergeUploadSessionUploadedPart(sessionId, uploadedParts[0])
        : await mergeUploadSessionUploadedParts(sessionId, uploadedParts);
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
