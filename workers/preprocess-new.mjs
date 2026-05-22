import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { logWorkerRuntimeShutdown, logWorkerRuntimeStarted } from "./_runtime.mjs";

const { Pool } = pg;

const env = {
  DATABASE_URL: readEnv("DATABASE_URL"),
  WEB_MVP_SCHEMA: readEnv("WEB_MVP_SCHEMA"),
  COS_SECRET_ID: readEnv("COS_SECRET_ID"),
  COS_SECRET_KEY: readEnv("COS_SECRET_KEY"),
  COS_REGION: readEnv("COS_REGION"),
  COS_BUCKET: readEnv("COS_BUCKET"),
  OPENAI_VIDEO_PREPROCESS_DOWNLOAD_SOURCE: readEnv("OPENAI_VIDEO_PREPROCESS_DOWNLOAD_SOURCE"),
  OPENAI_VIDEO_PREPROCESS_MIN_SUBMISSION_ID: readEnv("OPENAI_VIDEO_PREPROCESS_MIN_SUBMISSION_ID"),
  OPENAI_VIDEO_PREPROCESS_BATCH_LIMIT: readEnv("OPENAI_VIDEO_PREPROCESS_BATCH_LIMIT"),
  OPENAI_VIDEO_PREPROCESS_MAX_ATTEMPTS: readEnv("OPENAI_VIDEO_PREPROCESS_MAX_ATTEMPTS"),
  OPENAI_VIDEO_PREPROCESS_POLL_INTERVAL_MS: readEnv("OPENAI_VIDEO_PREPROCESS_POLL_INTERVAL_MS"),
  OPENAI_VIDEO_PREPROCESS_URL_EXPIRES_IN: readEnv("OPENAI_VIDEO_PREPROCESS_URL_EXPIRES_IN"),
  OPENAI_VIDEO_PREPROCESS_FFMPEG_TIMEOUT_MS: readEnv("OPENAI_VIDEO_PREPROCESS_FFMPEG_TIMEOUT_MS"),
  OPENAI_VIDEO_PREPROCESS_CONTACT_SHEET_EDGE: readEnv("OPENAI_VIDEO_PREPROCESS_CONTACT_SHEET_EDGE"),
  OPENAI_VIDEO_PREPROCESS_JPEG_QUALITY: readEnv("OPENAI_VIDEO_PREPROCESS_JPEG_QUALITY"),
  OPENAI_VIDEO_PREPROCESS_COLUMNS: readEnv("OPENAI_VIDEO_PREPROCESS_COLUMNS"),
  OPENAI_VIDEO_PREPROCESS_ROWS: readEnv("OPENAI_VIDEO_PREPROCESS_ROWS"),
  OPENAI_VIDEO_PREPROCESS_FFMPEG_BIN: readEnv("OPENAI_VIDEO_PREPROCESS_FFMPEG_BIN"),
  OPENAI_VIDEO_PREPROCESS_FFPROBE_BIN: readEnv("OPENAI_VIDEO_PREPROCESS_FFPROBE_BIN"),
};

const webMvpSchema = normalizePgIdentifier(env.WEB_MVP_SCHEMA || "web_mvp", "WEB_MVP_SCHEMA");
const videoSubmissionsTable = pgRelation("web_video_submissions");
const videoSubmissionArtifactsTable = pgRelation("web_video_submission_artifacts");

const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const minSubmissionId = parseBoundedInteger(
  env.OPENAI_VIDEO_PREPROCESS_MIN_SUBMISSION_ID,
  0,
  0,
  Number.MAX_SAFE_INTEGER,
);
const batchLimit = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_BATCH_LIMIT, 4, 1, 20);
const maxAttempts = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_MAX_ATTEMPTS, 3, 1, 10);
const pollIntervalMs = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_POLL_INTERVAL_MS, 30_000, 5_000, 10 * 60_000);
const urlExpiresIn = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_URL_EXPIRES_IN, 12 * 60 * 60, 3600, 72 * 60 * 60);
const ffmpegTimeoutMs = parseBoundedInteger(
  env.OPENAI_VIDEO_PREPROCESS_FFMPEG_TIMEOUT_MS,
  15 * 60 * 1000,
  60_000,
  60 * 60 * 1000,
);
const contactSheetEdge = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_CONTACT_SHEET_EDGE, 1800, 1200, 4096);
const jpegQuality = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_JPEG_QUALITY, 3, 2, 8);
const columns = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_COLUMNS, 4, 2, 6);
const rows = parseBoundedInteger(env.OPENAI_VIDEO_PREPROCESS_ROWS, 3, 2, 6);
const ffmpegBin = env.OPENAI_VIDEO_PREPROCESS_FFMPEG_BIN || "ffmpeg";
const ffprobeBin = env.OPENAI_VIDEO_PREPROCESS_FFPROBE_BIN || "ffprobe";
const shouldDownloadSourceVideo = parseBooleanEnv(env.OPENAI_VIDEO_PREPROCESS_DOWNLOAD_SOURCE);
const sourceDownloadMaxAttempts = 3;
const sourceDownloadRetryBaseDelayMs = 3_000;
const leaseSeconds = Math.max(Math.ceil(ffmpegTimeoutMs / 1000) + 600, 1800);
const tileMargin = 12;
const tilePadding = 8;
const workerRole = "openai-video-preprocess";
const workerEntry = "workers/preprocess-new.mjs";
const frameCountPerSheet = columns * rows;
const frameEdge = Math.max(
  160,
  Math.floor(
    Math.min(
      (contactSheetEdge - tileMargin * 2 - tilePadding * (columns - 1)) / columns,
      (contactSheetEdge - tileMargin * 2 - tilePadding * (rows - 1)) / rows,
    ),
  ),
);

let dbPool = null;
let storageClient = null;
let shuttingDown = false;

function normalizePgIdentifier(value, label) {
  if (/^[a-z_][a-z0-9_]*$/i.test(value)) {
    return value;
  }
  throw new Error(`Invalid ${label}: ${value}`);
}

function pgRelation(tableName) {
  return `${webMvpSchema}.${normalizePgIdentifier(tableName, "table name")}`;
}

function readEnv(name) {
  return process.env[name]?.trim() ?? "";
}

function parseBoundedInteger(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function parseBooleanEnv(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
}

function getDbPool() {
  if (dbPool) {
    return dbPool;
  }
  dbPool = new Pool({
    connectionString: env.DATABASE_URL,
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
    region: env.COS_REGION,
    endpoint: `https://cos.${env.COS_REGION}.myqcloud.com`,
    credentials: {
      accessKeyId: env.COS_SECRET_ID,
      secretAccessKey: env.COS_SECRET_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return storageClient;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRetryableSourceDownloadError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("aborted") ||
    message.includes("terminated") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

async function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
        reject(
          new Error(
            [
              `${command} exited with code ${code}${signal ? ` (${signal})` : ""}`,
              stderrText ? `stderr: ${stderrText}` : "",
              stdoutText ? `stdout: ${stdoutText}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf8"));
    });
  });
}

function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

function escapeDrawtextText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildDownloadProgress(downloadedBytes, totalBytes, startedAt) {
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const speedBytesPerSecond = downloadedBytes / elapsedSeconds;
  const parts = [];
  if (Number.isFinite(totalBytes) && totalBytes > 0) {
    const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
    const ratio = Math.max(0, Math.min(1, downloadedBytes / totalBytes));
    const filled = Math.round(ratio * 20);
    const bar = `${"#".repeat(filled)}${"-".repeat(Math.max(0, 20 - filled))}`;
    parts.push(`[${bar}]`);
    parts.push(`${percent}%`);
    parts.push(`${formatMb(downloadedBytes)} / ${formatMb(totalBytes)}`);
  } else {
    parts.push(formatMb(downloadedBytes));
  }
  parts.push(`${formatMb(speedBytesPerSecond)}/s`);
  return parts.join(" ");
}

function encodeCosObjectPath(objectKey) {
  return `/${String(objectKey)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function sha1Hex(value) {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

function hmacSha1Hex(key, value) {
  return createHmac("sha1", key).update(value, "utf8").digest("hex");
}

function cosEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .toLowerCase();
}

function canonicalizeParams(params) {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [String(key).toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    list: entries.map(([key]) => key).join(";"),
    string: entries.map(([key, value]) => `${cosEncode(key)}=${cosEncode(value)}`).join("&"),
  };
}

function createCosAuthorization({ method, objectKey, host, query }) {
  const now = Math.floor(Date.now() / 1000);
  const signTime = `${now};${now + urlExpiresIn}`;
  const pathName = encodeCosObjectPath(objectKey);
  const queryParts = canonicalizeParams(query);
  const headers = {
    host,
  };
  const headerParts = canonicalizeParams(headers);
  const httpString = [
    method.toLowerCase(),
    pathName,
    queryParts.string,
    headerParts.string,
    "",
  ].join("\n");
  const stringToSign = ["sha1", signTime, sha1Hex(httpString), ""].join("\n");
  const signKey = hmacSha1Hex(env.COS_SECRET_KEY, signTime);
  const signature = hmacSha1Hex(signKey, stringToSign);

  return [
    "q-sign-algorithm=sha1",
    `q-ak=${env.COS_SECRET_ID}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    `q-header-list=${headerParts.list}`,
    `q-url-param-list=${queryParts.list}`,
    `q-signature=${signature}`,
  ].join("&");
}

function createCiRequest(bucket, region, objectKey, query) {
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const searchParams = new URLSearchParams(query);
  return {
    url: `https://${host}${encodeCosObjectPath(objectKey)}?${searchParams.toString()}`,
    headers: {
      Authorization: createCosAuthorization({
        method: "GET",
        objectKey,
        host,
        query,
      }),
    },
  };
}

async function writeBodyToFile(body, filePath, progress, options = {}) {
  if (!body) {
    throw new Error(`COS object body is empty for ${filePath}`);
  }

  const append = options.append === true;
  const initialBytes = Number(options.initialBytes ?? 0);
  const handle = await open(filePath, append ? "a" : "w");
  let bytesWritten = Math.max(0, initialBytes);
  let lastLogAt = Date.now();
  let lastLogBytes = bytesWritten;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      await handle.write(buffer);
      bytesWritten += buffer.length;
      const now = Date.now();
      if (progress && (now - lastLogAt >= 1000 || bytesWritten - lastLogBytes >= 8 * 1024 * 1024)) {
        progress(bytesWritten);
        lastLogAt = now;
        lastLogBytes = bytesWritten;
      }
    }
  } finally {
    await handle.close();
  }

  if (bytesWritten <= 0) {
    throw new Error(`Downloaded COS object is empty: ${filePath}`);
  }
  return bytesWritten;
}

function parseContentRangeTotal(contentRange) {
  const match = String(contentRange || "").match(/\/(\d+)$/);
  if (!match) {
    return null;
  }
  const total = Number.parseInt(match[1], 10);
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function getExistingFileSize(filePath) {
  try {
    const fileStat = await stat(filePath);
    return Number.isFinite(Number(fileStat.size)) ? Number(fileStat.size) : 0;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function downloadSourceVideo(bucket, objectKey, outputPath) {
  const startedAt = Date.now();
  const existingBytes = await getExistingFileSize(outputPath);
  const isResume = existingBytes > 0;
  console.info("openai video preprocess source download started", {
    workerId,
    bucket,
    objectKey,
    outputPath,
    existingBytes: isResume ? existingBytes : 0,
    resume: isResume,
  });
  const request = {
    Bucket: bucket,
    Key: objectKey,
  };
  if (isResume) {
    request.Range = `bytes=${existingBytes}-`;
  }
  const response = await getStorageClient().send(new GetObjectCommand(request));
  if (isResume && !response.ContentRange) {
    await rm(outputPath, { force: true });
    throw new Error("Range resume not supported by source download response");
  }
  const totalBytes =
    parseContentRangeTotal(response.ContentRange) ??
    (Number.isFinite(Number(response.ContentLength ?? 0))
      ? Number(response.ContentLength ?? 0) + (isResume ? existingBytes : 0)
      : 0);
  if (Number.isFinite(totalBytes) && totalBytes > 0) {
    console.info("openai video preprocess source download size", {
      workerId,
      bucket,
      objectKey,
      totalBytes,
      total: formatMb(totalBytes),
      resumedFromBytes: isResume ? existingBytes : 0,
    });
  }
  const bytesWritten = await writeBodyToFile(
    response.Body,
    outputPath,
    (downloadedBytes) => {
      console.info("openai video preprocess source download progress", {
        workerId,
        bucket,
        objectKey,
        downloadedBytes,
        totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
        progress: buildDownloadProgress(downloadedBytes, totalBytes, startedAt),
      });
    },
    {
      append: isResume,
      initialBytes: existingBytes,
    },
  );
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  console.info("openai video preprocess source download completed", {
    workerId,
    bucket,
    objectKey,
    bytesWritten,
    downloaded: formatMb(bytesWritten),
    elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
    averageSpeed: `${formatMb(bytesWritten / elapsedSeconds)}/s`,
  });
  return {
    bytesWritten,
    contentType: response.ContentType ?? null,
  };
}

async function downloadSourceVideoWithRetry(submissionId, bucket, objectKey, outputPath) {
  for (let attempt = 1; attempt <= sourceDownloadMaxAttempts; attempt += 1) {
    try {
      return await downloadSourceVideo(bucket, objectKey, outputPath);
    } catch (error) {
      const message = getErrorMessage(error);
      if (attempt >= sourceDownloadMaxAttempts || !isRetryableSourceDownloadError(error)) {
        throw error;
      }
      const existingBytes = await getExistingFileSize(outputPath);
      const retryInMs = sourceDownloadRetryBaseDelayMs * attempt;
      console.warn("openai video preprocess source download retry scheduled", {
        workerId,
        submissionId,
        bucket,
        objectKey,
        attempt,
        maxAttempts: sourceDownloadMaxAttempts,
        existingBytes,
        retryInMs,
        message,
      });
      await sleep(retryInMs);
    }
  }
  throw new Error(`Source download retry loop exhausted for submission ${submissionId}`);
}

async function probeDuration(videoPath) {
  const stdout = await runCommand(
    ffprobeBin,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", videoPath],
    ffmpegTimeoutMs,
  );
  const parsed = JSON.parse(stdout);
  const duration = Number.parseFloat(String(parsed?.format?.duration ?? ""));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe did not return a valid duration");
  }
  return duration;
}

function parseMediaInfoDuration(xmlText) {
  const candidates = [
    /<Format>[\s\S]*?<Duration>([^<]+)<\/Duration>[\s\S]*?<\/Format>/i,
    /<Duration>([^<]+)<\/Duration>/i,
  ];
  for (const pattern of candidates) {
    const match = xmlText.match(pattern);
    const duration = Number.parseFloat(String(match?.[1] ?? ""));
    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  }
  throw new Error("CI videoinfo did not return a valid duration");
}

async function fetchWithTimeout(url, timeoutMs, headers = undefined) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getCiMediaDuration(bucket, region, objectKey) {
  const request = createCiRequest(bucket, region, objectKey, {
    "ci-process": "videoinfo",
  });
  const response = await fetchWithTimeout(request.url, ffmpegTimeoutMs, request.headers);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`CI videoinfo failed with ${response.status}: ${body.slice(0, 1000)}`);
  }
  const durationSec = parseMediaInfoDuration(body);
  console.info("openai video preprocess ci videoinfo completed", {
    workerId,
    bucket,
    objectKey,
    durationSec,
  });
  return durationSec;
}

async function probeImageSize(filePath) {
  const stdout = await runCommand(
    ffprobeBin,
    ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", filePath],
    ffmpegTimeoutMs,
  );
  const parsed = JSON.parse(stdout);
  const stream = parsed?.streams?.[0] ?? {};
  const width = Number.parseInt(String(stream.width ?? ""), 10);
  const height = Number.parseInt(String(stream.height ?? ""), 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Could not probe image dimensions for ${filePath}`);
  }
  return { width, height };
}

function determineSheetCount(durationSec) {
  if (durationSec <= 180) {
    return 1;
  }
  if (durationSec <= 600) {
    return 2;
  }
  return 4;
}

function buildSheetPlan(durationSec) {
  const sheetCount = determineSheetCount(durationSec);
  const segmentDuration = durationSec / sheetCount;
  const segments = [];

  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
    const segmentStart = sheetIndex * segmentDuration;
    const segmentEnd = Math.min(durationSec, (sheetIndex + 1) * segmentDuration);
    const points = [];

    for (let frameIndex = 0; frameIndex < frameCountPerSheet; frameIndex += 1) {
      const ratio = (frameIndex + 0.5) / frameCountPerSheet;
      const second = Math.min(
        Math.max(segmentStart + (segmentEnd - segmentStart) * ratio, 0),
        Math.max(durationSec - 0.2, 0),
      );
      points.push(Number(second.toFixed(3)));
    }

    segments.push({
      segmentIndex: sheetIndex,
      segmentStart,
      segmentEnd,
      timePointsSec: points,
    });
  }

  return segments;
}

async function extractFrame(videoPath, second, outputPath) {
  const timestamp = escapeDrawtextText(formatSeconds(second));
  const filter = [
    `scale=${frameEdge}:${frameEdge}:force_original_aspect_ratio=decrease`,
    `pad=${frameEdge}:${frameEdge}:(ow-iw)/2:(oh-ih)/2:black`,
    `drawtext=fontcolor=white:fontsize=28:box=1:boxcolor=0x00000088:text='${timestamp}':x=20:y=h-th-20`,
  ].join(",");
  await runCommand(
    ffmpegBin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      second.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      filter,
      "-q:v",
      String(jpegQuality),
      outputPath,
    ],
    ffmpegTimeoutMs,
  );
}

async function downloadCiSnapshot(bucket, region, objectKey, second, outputPath) {
  const request = createCiRequest(bucket, region, objectKey, {
    "ci-process": "snapshot",
    time: second.toFixed(3),
    format: "jpg",
    mode: "exactframe",
    rotate: "auto",
  });
  const startedAt = Date.now();
  const response = await fetchWithTimeout(request.url, ffmpegTimeoutMs, request.headers);
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`CI snapshot failed with ${response.status} at ${second.toFixed(3)}s: ${body.toString("utf8").slice(0, 1000)}`);
  }
  if (body.length <= 0) {
    throw new Error(`CI snapshot returned an empty image at ${second.toFixed(3)}s`);
  }
  await writeFile(outputPath, body);
  console.info("openai video preprocess ci snapshot completed", {
    workerId,
    bucket,
    objectKey,
    second: Number(second.toFixed(3)),
    imageBytes: body.length,
    elapsedMs: Date.now() - startedAt,
  });
}

async function normalizeFrame(inputPath, second, outputPath) {
  const timestamp = escapeDrawtextText(formatSeconds(second));
  const filter = [
    `scale=${frameEdge}:${frameEdge}:force_original_aspect_ratio=decrease`,
    `pad=${frameEdge}:${frameEdge}:(ow-iw)/2:(oh-ih)/2:black`,
    `drawtext=fontcolor=white:fontsize=28:box=1:boxcolor=0x00000088:text='${timestamp}':x=20:y=h-th-20`,
  ].join(",");
  await runCommand(
    ffmpegBin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      filter,
      "-q:v",
      String(jpegQuality),
      outputPath,
    ],
    ffmpegTimeoutMs,
  );
}

async function tileFrames(framePattern, outputPath) {
  const filter = `tile=${columns}x${rows}:margin=${tileMargin}:padding=${tilePadding}:color=black`;
  await runCommand(
    ffmpegBin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      "1",
      "-i",
      framePattern,
      "-frames:v",
      "1",
      "-vf",
      filter,
      "-q:v",
      String(jpegQuality),
      outputPath,
    ],
    ffmpegTimeoutMs,
  );
}

async function describeSheetFile(filePath) {
  const [buffer, fileStat, dimensions] = await Promise.all([
    readFile(filePath),
    stat(filePath),
    probeImageSize(filePath),
  ]);
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: Number(fileStat.size),
    width: dimensions.width,
    height: dimensions.height,
    body: buffer,
  };
}

async function uploadSheet(bucket, objectKey, body) {
  await getStorageClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: "image/jpeg",
    }),
  );
}

async function claimNextSubmission() {
  const result = await getDbPool().query(
    `with candidate as (
       select id
       from ${videoSubmissionsTable}
       where coalesce(raw_key, object_key) is not null
         and id >= $3
         and coalesce(analysis_status, 'queued') in ('queued', 'retry_pending', 'pending', 'failed')
         and (lease_expires_at is null or lease_expires_at < now())
       order by id asc
       for update skip locked
       limit 1
     )
     update ${videoSubmissionsTable} s
     set analysis_status = 'preprocessing',
         preprocess_version = s.preprocess_version + 1,
         last_error = null,
         lease_owner = $1,
         lease_expires_at = now() + make_interval(secs => $2),
         analysis_started_at = coalesce(s.analysis_started_at, now()),
         analysis_completed_at = null
     from candidate
     where s.id = candidate.id
     returning s.*`,
    [workerId, leaseSeconds, minSubmissionId],
  );
  return result.rows[0] ?? null;
}

async function markExpiredLeasesRetryable() {
  await getDbPool().query(
    `update ${videoSubmissionsTable}
     set analysis_status = 'retry_pending',
         last_error = coalesce(last_error, 'Preprocess worker lease expired before completion.'),
         lease_owner = null,
         lease_expires_at = null
     where analysis_status = 'preprocessing'
       and lease_expires_at is not null
       and lease_expires_at < now()`,
  );
}

async function saveArtifacts(submissionId, preprocessVersion, artifacts) {
  await getDbPool().query(
    `delete from ${videoSubmissionArtifactsTable}
     where submission_id = $1
       and preprocess_version = $2`,
    [submissionId, preprocessVersion],
  );

  for (const artifact of artifacts) {
    await getDbPool().query(
      `insert into ${videoSubmissionArtifactsTable} (
         submission_id,
         preprocess_version,
         artifact_type,
         bucket,
         region,
         object_key,
         sha256,
         width,
         height,
         size_bytes,
         segment_index,
         time_points_json,
         metadata_json
       ) values ($1, $2, 'contact_sheet', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)`,
      [
        submissionId,
        preprocessVersion,
        artifact.bucket,
        artifact.region,
        artifact.objectKey,
        artifact.sha256,
        artifact.width,
        artifact.height,
        artifact.sizeBytes,
        artifact.segmentIndex,
        JSON.stringify(artifact.timePointsSec),
        JSON.stringify(artifact.metadata ?? {}),
      ],
    );
  }
}

async function markPreprocessSucceeded(submission, manifest, artifacts, durationSec) {
  await saveArtifacts(submission.id, submission.preprocess_version, artifacts);
  await getDbPool().query(
    `update ${videoSubmissionsTable}
     set analysis_status = 'preprocess_ready',
         duration_sec = $2,
         analysis_summary = 'Contact sheets ready for OpenAI Batch review',
         analysis_payload = jsonb_build_object(
           'provider', 'openai_batch',
           'stage', 'preprocess_ready',
           'preprocess_version', $3::integer,
           'contact_sheet_count', $4::integer
         ),
         contact_sheet_manifest_json = $5::jsonb,
         contact_sheet_count = $4,
         last_error = null,
         lease_owner = null,
         lease_expires_at = null
     where id = $1`,
    [
      submission.id,
      durationSec,
      submission.preprocess_version,
      artifacts.length,
      JSON.stringify(manifest),
    ],
  );
}

async function markPreprocessFailed(submission, error) {
  const attempt = Number(submission.preprocess_version ?? 0);
  const nextStatus = attempt >= maxAttempts ? "failed_terminal" : "retry_pending";
  const message = error instanceof Error ? error.message : String(error);
  await getDbPool().query(
    `update ${videoSubmissionsTable}
     set analysis_status = $2::text,
         analysis_summary = $3::text,
         analysis_payload = jsonb_build_object(
           'provider', 'openai_batch',
           'stage', 'preprocess_failed',
           'preprocess_version', $4::integer,
           'error', $3::text
         ),
         last_error = $3::text,
         lease_owner = null,
         lease_expires_at = null,
         analysis_completed_at = case when $2::text = 'failed_terminal' then now() else null end
     where id = $1`,
    [submission.id, nextStatus, message.slice(0, 4000), attempt],
  );
}

async function preprocessSubmission(submission) {
  const bucket = String(submission.raw_bucket || env.COS_BUCKET || "").trim();
  const objectKey = String(submission.raw_key || submission.object_key || "").trim();
  const region = String(submission.raw_region || env.COS_REGION || "").trim();
  if (!bucket || !objectKey || !region) {
    throw new Error(`Submission ${submission.id} is missing raw COS location metadata`);
  }

  const workDir = path.join(
    os.tmpdir(),
    `openai-video-preprocess-${submission.id}-${submission.preprocess_version}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(workDir, { recursive: true });

  try {
    let durationSec;
    let sourceVideoPath = null;
    if (shouldDownloadSourceVideo) {
      const extension = path.extname(objectKey) || ".mp4";
      sourceVideoPath = path.join(workDir, `source-video${extension}`);
      console.info("openai video preprocess source download enabled", {
        workerId,
        submissionId: submission.id,
        bucket,
        objectKey,
        sourceVideoPath,
      });
      await downloadSourceVideoWithRetry(submission.id, bucket, objectKey, sourceVideoPath);
      durationSec = await probeDuration(sourceVideoPath);
    } else {
      durationSec = await getCiMediaDuration(bucket, region, objectKey);
    }
    const plan = buildSheetPlan(durationSec);
    const artifacts = [];

    for (const segment of plan) {
      const sheetDir = path.join(workDir, `sheet-${String(segment.segmentIndex).padStart(2, "0")}`);
      await mkdir(sheetDir, { recursive: true });

      for (let index = 0; index < segment.timePointsSec.length; index += 1) {
        const second = segment.timePointsSec[index];
        const rawFramePath = path.join(sheetDir, `raw-frame-${String(index).padStart(2, "0")}.jpg`);
        const framePath = path.join(sheetDir, `frame-${String(index).padStart(2, "0")}.jpg`);
        if (sourceVideoPath) {
          await extractFrame(sourceVideoPath, second, framePath);
        } else {
          await downloadCiSnapshot(bucket, region, objectKey, second, rawFramePath);
          await normalizeFrame(rawFramePath, second, framePath);
        }
      }

      const sheetPath = path.join(workDir, `sheet-${String(segment.segmentIndex).padStart(2, "0")}.jpg`);
      await tileFrames(path.join(sheetDir, "frame-%02d.jpg"), sheetPath);
      const described = await describeSheetFile(sheetPath);
      const objectKeyOut =
        `contact-sheet/${submission.id}/${submission.preprocess_version}/` +
        `sheet-${String(segment.segmentIndex).padStart(2, "0")}.jpg`;
      await uploadSheet(bucket, objectKeyOut, described.body);

      artifacts.push({
        bucket,
        region,
        objectKey: objectKeyOut,
        sha256: described.sha256,
        width: described.width,
        height: described.height,
        sizeBytes: described.sizeBytes,
        segmentIndex: segment.segmentIndex,
        timePointsSec: segment.timePointsSec,
        metadata: {
          duration_sec: durationSec,
          segment_start_sec: Number(segment.segmentStart.toFixed(3)),
          segment_end_sec: Number(segment.segmentEnd.toFixed(3)),
          columns,
          rows,
        },
      });
    }

    const manifest = {
      version: 1,
      preprocess_version: submission.preprocess_version,
      duration_sec: Number(durationSec.toFixed(3)),
      sheet_count: artifacts.length,
      columns,
      rows,
      generated_by: workerId,
      sheets: artifacts.map((artifact) => ({
        segment_index: artifact.segmentIndex,
        bucket: artifact.bucket,
        region: artifact.region,
        object_key: artifact.objectKey,
        sha256: artifact.sha256,
        width: artifact.width,
        height: artifact.height,
        size_bytes: artifact.sizeBytes,
        time_points_sec: artifact.timePointsSec,
        ...artifact.metadata,
      })),
    };

    await markPreprocessSucceeded(submission, manifest, artifacts, durationSec);
    console.info("openai video preprocess completed", {
      workerId,
      submissionId: submission.id,
      preprocessVersion: submission.preprocess_version,
      durationSec,
      sheetCount: artifacts.length,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runOnce() {
  await markExpiredLeasesRetryable();

  let processed = 0;
  while (processed < batchLimit && !shuttingDown) {
    const submission = await claimNextSubmission();
    if (!submission) {
      break;
    }

    console.info("openai video preprocess claimed", {
      workerId,
      submissionId: submission.id,
      preprocessVersion: submission.preprocess_version,
      objectKey: submission.raw_key || submission.object_key,
    });

    try {
      await preprocessSubmission(submission);
    } catch (error) {
      console.error("openai video preprocess failed", {
        workerId,
        submissionId: submission.id,
        preprocessVersion: submission.preprocess_version,
        message: error instanceof Error ? error.message : String(error),
      });
      await markPreprocessFailed(submission, error);
    }

    processed += 1;
  }

  return processed;
}

async function runLoop() {
  requireEnv("DATABASE_URL", env.DATABASE_URL);
  requireEnv("COS_SECRET_ID", env.COS_SECRET_ID);
  requireEnv("COS_SECRET_KEY", env.COS_SECRET_KEY);
  requireEnv("COS_REGION", env.COS_REGION);
  requireEnv("COS_BUCKET", env.COS_BUCKET);

  logWorkerRuntimeStarted({
    role: workerRole,
    entry: workerEntry,
    workerId,
    extra: {
      minSubmissionId,
      batchLimit,
      maxAttempts,
      pollIntervalMs,
      shouldDownloadSourceVideo,
    },
  });
  console.info("openai video preprocess worker started", {
    workerId,
    minSubmissionId,
    batchLimit,
    maxAttempts,
    pollIntervalMs,
    shouldDownloadSourceVideo,
    contactSheetEdge,
    columns,
    rows,
  });

  while (!shuttingDown) {
    try {
      const processed = await runOnce();
      if (processed === 0) {
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      console.error("openai video preprocess loop failed", {
        workerId,
        message: error instanceof Error ? error.message : String(error),
      });
      await sleep(pollIntervalMs);
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logWorkerRuntimeShutdown({
    role: workerRole,
    entry: workerEntry,
    workerId,
    extra: { signal },
  });
  console.info("openai video preprocess worker shutting down", { workerId, signal });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

runLoop()
  .catch((error) => {
    console.error("openai video preprocess worker crashed", {
      workerId,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dbPool) {
      await dbPool.end();
    }
  });
