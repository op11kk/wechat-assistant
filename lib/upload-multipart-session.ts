import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/** 单片大小（需低于 Vercel 单次请求体上限，留出余量） */
export const MULTIPART_PART_SIZE_BYTES = 3 * 1024 * 1024;

/** 大于此体积走分片中转，否则仍用单次 /upload/proxy */
export const SINGLE_PROXY_MAX_BYTES = MULTIPART_PART_SIZE_BYTES;

/** 允许的单片请求体上限（含少量余量） */
export const MULTIPART_MAX_REQUEST_BODY_BYTES = MULTIPART_PART_SIZE_BYTES + 256 * 1024;

export function getMultipartSigningSecret(): string | null {
  const s = env.API_SECRET || env.WECHAT_TOKEN;
  return s || null;
}

export type MultipartSessionPayload = {
  v: 1;
  uploadId: string;
  objectKey: string;
  participantCode: string;
  wechatOpenid: string;
  fileName: string;
  contentType: string;
  totalSize: number;
  exp: number;
};

function signPayload(p: MultipartSessionPayload, secret: string): string {
  const canonical = `${p.v}|${p.uploadId}|${p.objectKey}|${p.participantCode}|${p.wechatOpenid}|${p.fileName}|${p.contentType}|${p.totalSize}|${p.exp}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function encodeSessionToken(p: MultipartSessionPayload, secret: string): string {
  const sig = signPayload(p, secret);
  return Buffer.from(JSON.stringify({ ...p, sig }), "utf8").toString("base64url");
}

export function decodeAndVerifySessionToken(
  token: string,
  secret: string,
): { ok: true; payload: MultipartSessionPayload } | { ok: false; error: string } {
  let raw: MultipartSessionPayload & { sig?: string };
  try {
    raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as MultipartSessionPayload & { sig?: string };
  } catch {
    return { ok: false, error: "invalid token encoding" };
  }
  const { sig, ...rest } = raw;
  const payload = rest as MultipartSessionPayload;
  if (!sig || typeof sig !== "string") {
    return { ok: false, error: "missing sig" };
  }
  if (payload.v !== 1) {
    return { ok: false, error: "bad version" };
  }
  const expected = signPayload(payload, secret);
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, error: "bad signature" };
    }
  } catch {
    return { ok: false, error: "sig compare failed" };
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, error: "session expired" };
  }
  return { ok: true, payload };
}
