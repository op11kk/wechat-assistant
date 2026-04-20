import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const { Pool } = pg;

const env = {
  PORT: readEnv("PORT") || "7001",
  WORKER_SECRET: readEnv("WORKER_SECRET"),
  WECHAT_APP_ID: readEnv("WECHAT_APP_ID"),
  WECHAT_APP_SECRET: readEnv("WECHAT_APP_SECRET"),
  DATABASE_URL: readEnv("DATABASE_URL"),
  COS_SECRET_ID: readEnv("COS_SECRET_ID"),
  COS_SECRET_KEY: readEnv("COS_SECRET_KEY"),
  COS_REGION: readEnv("COS_REGION"),
  COS_BUCKET: readEnv("COS_BUCKET"),
  COS_PUBLIC_BASE_URL: readEnv("COS_PUBLIC_BASE_URL"),
};

const WECHAT_TOKEN_TIMEOUT_MS = 10_000;
const WECHAT_MEDIA_TIMEOUT_MS = 120_000;
const COS_UPLOAD_TIMEOUT_MS = 120_000;

let tokenCache = {
  token: null,
  deadline: 0,
};

let storageClient = null;
let dbPool = null;

function readEnv(name) {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name) {
  if (!env[name]) {
    throw new Error(`Missing ${name}`);
  }
  return env[name];
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw);
}

async function withTimeout(label, timeoutMs, fn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    console.error(`${label} failed`, {
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
      timeoutMs,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getDbPool() {
  if (dbPool) {
    return dbPool;
  }
  dbPool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return dbPool;
}

function getStorageClient() {
  if (storageClient) {
    return storageClient;
  }
  storageClient = new S3Client({
    region: requireEnv("COS_REGION"),
    endpoint: `https://cos.${requireEnv("COS_REGION")}.myqcloud.com`,
    credentials: {
      accessKeyId: requireEnv("COS_SECRET_ID"),
      secretAccessKey: requireEnv("COS_SECRET_KEY"),
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return storageClient;
}

async function getWechatAccessToken() {
  requireEnv("WECHAT_APP_ID");
  requireEnv("WECHAT_APP_SECRET");
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.deadline) {
    return tokenCache.token;
  }
  const query = new URLSearchParams({
    grant_type: "client_credential",
    appid: env.WECHAT_APP_ID,
    secret: env.WECHAT_APP_SECRET,
  });
  console.info("worker wechat token request started");
  const response = await withTimeout("worker wechat token request", WECHAT_TOKEN_TIMEOUT_MS, (signal) =>
    fetch(`https://api.weixin.qq.com/cgi-bin/token?${query.toString()}`, {
      cache: "no-store",
      signal,
    }),
  );
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    console.error("worker wechat token request failed", payload);
    throw new Error(`WeChat token request failed: ${JSON.stringify(payload)}`);
  }
  const expires = payload.expires_in ?? 7200;
  tokenCache = {
    token: payload.access_token,
    deadline: now + Math.max(120_000, (expires - 300) * 1000),
  };
  console.info("worker wechat token request succeeded", { expiresIn: expires });
  return tokenCache.token;
}

async function downloadWechatMedia(mediaId) {
  const token = await getWechatAccessToken();
  const query = new URLSearchParams({
    access_token: token,
    media_id: mediaId,
  });
  console.info("worker wechat media download started", { mediaId });
  const response = await withTimeout("worker wechat media download", WECHAT_MEDIA_TIMEOUT_MS, (signal) =>
    fetch(`https://api.weixin.qq.com/cgi-bin/media/get?${query.toString()}`, {
      cache: "no-store",
      signal,
    }),
  );
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "video/mp4";
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`WeChat media download failed: ${response.status} ${body.toString("utf8").slice(0, 400)}`);
  }
  if (contentType.includes("application/json") || body.subarray(0, 1).toString() === "{") {
    throw new Error(`WeChat media returned JSON: ${body.toString("utf8").slice(0, 400)}`);
  }
  console.info("worker wechat media download completed", {
    mediaId,
    contentType,
    sizeBytes: body.length,
  });
  return { body, contentType };
}

function extensionFor(contentType) {
  const byType = {
    "video/mp4": ".mp4",
    "video/mpeg": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-msvideo": ".avi",
  };
  return byType[contentType?.toLowerCase?.()] ?? ".mp4";
}

function buildObjectKey(participantCode, submissionId, contentType) {
  return `uploads/${participantCode}/chat/${submissionId}${extensionFor(contentType)}`;
}

async function uploadToCos(objectKey, body, contentType) {
  requireEnv("COS_BUCKET");
  console.info("worker cos upload started", {
    objectKey,
    sizeBytes: body.length,
    contentType,
  });
  await withTimeout("worker cos upload", COS_UPLOAD_TIMEOUT_MS, (abortSignal) =>
    getStorageClient().send(
      new PutObjectCommand({
        Bucket: env.COS_BUCKET,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
      { abortSignal },
    ),
  );
  console.info("worker cos upload completed", { objectKey });
}

async function updateSubmission(submissionId, patch) {
  const assignments = [];
  const values = [];
  let index = 1;
  for (const [column, value] of Object.entries(patch)) {
    assignments.push(`${column} = $${index}`);
    values.push(value);
    index += 1;
  }
  if (assignments.length === 0) {
    return;
  }
  values.push(submissionId);
  await getDbPool().query(
    `update public.video_submissions set ${assignments.join(", ")} where id = $${index}`,
    values,
  );
}

function assertAuthorized(req) {
  const expected = requireEnv("WORKER_SECRET");
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${expected}`;
}

async function handleMediaSync(req, res) {
  if (!assertAuthorized(req)) {
    jsonResponse(res, 401, { error: "unauthorized" });
    return;
  }
  const requestId = randomUUID();
  const body = await readJsonBody(req);
  const submissionId = Number.parseInt(String(body?.submission_id ?? ""), 10);
  const mediaId = String(body?.media_id ?? "").trim();
  const participantCode = String(body?.participant_code ?? "").trim();
  if (!Number.isFinite(submissionId) || !mediaId || !participantCode) {
    jsonResponse(res, 400, {
      error: "submission_id, media_id, participant_code required",
      request_id: requestId,
    });
    return;
  }
  jsonResponse(res, 202, {
    message: "accepted",
    request_id: requestId,
    submission_id: submissionId,
  });
  void processMediaSync({
    requestId,
    submissionId,
    mediaId,
    participantCode,
  }).catch(async (error) => {
    console.error("worker media sync failed", {
      requestId,
      submissionId,
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
    });
    await updateSubmission(submissionId, {
      user_comment: `worker sync failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    }).catch((updateError) => {
      console.error("worker failure update failed", {
        requestId,
        submissionId,
        message: updateError instanceof Error ? updateError.message : String(updateError),
      });
    });
  });
}

async function processMediaSync({ requestId, submissionId, mediaId, participantCode }) {
  console.info("worker media sync started", {
    requestId,
    submissionId,
    participantCode,
  });
  const download = await downloadWechatMedia(mediaId);
  const objectKey = buildObjectKey(participantCode, submissionId, download.contentType);
  await uploadToCos(objectKey, download.body, download.contentType);
  await updateSubmission(submissionId, {
    object_key: objectKey,
    size_bytes: download.body.length,
    mime: download.contentType,
  });
  console.info("worker media sync completed", {
    requestId,
    submissionId,
    objectKey,
    sizeBytes: download.body.length,
    contentType: download.contentType,
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/wechat-media-sync") {
      await handleMediaSync(req, res);
      return;
    }
    jsonResponse(res, 404, { error: "not found" });
  } catch (error) {
    console.error("worker request failed", {
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
    });
    jsonResponse(res, 500, {
      error: "worker request failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(Number.parseInt(env.PORT, 10), () => {
  console.info("wechat media worker listening", {
    port: env.PORT,
  });
});
