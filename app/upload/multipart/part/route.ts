import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { hasObjectStorageConfig } from "@/lib/env";
import { jsonResponse } from "@/lib/http";
import { s3UploadPart } from "@/lib/r2";
import {
  decodeAndVerifySessionToken,
  getMultipartSigningSecret,
  MULTIPART_MAX_REQUEST_BODY_BYTES,
  MULTIPART_PART_SIZE_BYTES,
} from "@/lib/upload-multipart-session";

export const runtime = "nodejs";
export const maxDuration = 120;

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

  const sessionToken = request.headers.get("x-multipart-session")?.trim() ?? "";
  const partNumberRaw = request.headers.get("x-part-number")?.trim() ?? "";
  const participantCode = request.headers.get("x-participant-code")?.trim() ?? "";
  const wechatOpenid = request.headers.get("x-wechat-openid")?.trim() ?? "";

  const partNumber = Number.parseInt(partNumberRaw, 10);
  if (!sessionToken || !Number.isFinite(partNumber) || partNumber < 1) {
    return jsonResponse(
      { error: "Missing or invalid headers", detail: "X-Multipart-Session, X-Part-Number (>=1) required" },
      400,
    );
  }

  const verified = decodeAndVerifySessionToken(sessionToken, signingSecret);
  if (!verified.ok) {
    return jsonResponse({ error: "Invalid session", detail: verified.error }, 403);
  }
  const session = verified.payload;
  if (session.participantCode !== participantCode || session.wechatOpenid !== wechatOpenid) {
    return jsonResponse(
      { error: "Participant headers mismatch session", detail: "X-Participant-Code / X-Wechat-Openid must match init" },
      403,
    );
  }

  const totalParts = Math.ceil(session.totalSize / MULTIPART_PART_SIZE_BYTES);
  if (partNumber > totalParts) {
    return jsonResponse({ error: "Part number out of range", detail: `max ${totalParts}` }, 400);
  }

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) {
    return jsonResponse({ error: "Empty part body" }, 400);
  }
  if (buf.length > MULTIPART_MAX_REQUEST_BODY_BYTES) {
    return jsonResponse(
      { error: "Part too large", detail: `max ${MULTIPART_MAX_REQUEST_BODY_BYTES} bytes per request` },
      413,
    );
  }

  const expectedLast = session.totalSize - (totalParts - 1) * MULTIPART_PART_SIZE_BYTES;
  if (partNumber < totalParts && buf.length !== MULTIPART_PART_SIZE_BYTES) {
    return jsonResponse(
      {
        error: "Unexpected part size",
        detail: `Parts 1..${totalParts - 1} must be exactly ${MULTIPART_PART_SIZE_BYTES} bytes`,
      },
      400,
    );
  }
  if (partNumber === totalParts && buf.length !== expectedLast) {
    return jsonResponse(
      {
        error: "Final part size mismatch",
        detail: `Expected ${expectedLast} bytes for part ${totalParts}`,
      },
      400,
    );
  }

  let etag: string;
  try {
    etag = await s3UploadPart({
      objectKey: session.objectKey,
      uploadId: session.uploadId,
      partNumber,
      body: buf,
    });
  } catch (error) {
    console.error("UploadPart failed", error);
    return jsonResponse({ error: "UploadPart failed", detail: String(error) }, 502);
  }

  return jsonResponse({ etag });
}
