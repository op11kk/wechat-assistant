import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";

import { logWorkerRuntimeShutdown, logWorkerRuntimeStarted } from "./_runtime.mjs";

const { Pool } = pg;

const env = {
  DATABASE_URL: readEnv("DATABASE_URL"),
  WEB_MVP_SCHEMA: readEnv("WEB_MVP_SCHEMA"),
  CLOUDFLARE_R2_ACCOUNT_ID: readEnv("CLOUDFLARE_R2_ACCOUNT_ID"),
  CLOUDFLARE_R2_ACCESS_KEY_ID: readEnv("CLOUDFLARE_R2_ACCESS_KEY_ID"),
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: readEnv("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
  CLOUDFLARE_R2_BUCKET: readEnv("CLOUDFLARE_R2_BUCKET"),
  COS_SECRET_ID: readEnv("COS_SECRET_ID"),
  COS_SECRET_KEY: readEnv("COS_SECRET_KEY"),
  COS_REGION: readEnv("COS_REGION"),
  COS_BUCKET: readEnv("COS_BUCKET"),
  VIDEO_ANALYSIS_PYTHON_BIN: readEnv("VIDEO_ANALYSIS_PYTHON_BIN"),
  VIDEO_ANALYSIS_SCRIPT_PATH: readEnv("VIDEO_ANALYSIS_SCRIPT_PATH"),
  VIDEO_ANALYSIS_POLL_INTERVAL_MS: readEnv("VIDEO_ANALYSIS_POLL_INTERVAL_MS"),
  VIDEO_ANALYSIS_DOWNLOAD_URL_EXPIRES_IN: readEnv("VIDEO_ANALYSIS_DOWNLOAD_URL_EXPIRES_IN"),
  VIDEO_ANALYSIS_PROVIDER: readEnv("VIDEO_ANALYSIS_PROVIDER"),
  VIDEO_ANALYSIS_SAMPLE_FPS: readEnv("VIDEO_ANALYSIS_SAMPLE_FPS"),
  VIDEO_ANALYSIS_MIN_WINDOW_HIT_RATIO: readEnv("VIDEO_ANALYSIS_MIN_WINDOW_HIT_RATIO"),
  VIDEO_ANALYSIS_PASS_RATIO: readEnv("VIDEO_ANALYSIS_PASS_RATIO"),
  VIDEO_ANALYSIS_REVIEW_RATIO: readEnv("VIDEO_ANALYSIS_REVIEW_RATIO"),
  VIDEO_ANALYSIS_TIMEOUT_MS: readEnv("VIDEO_ANALYSIS_TIMEOUT_MS"),
};

const webMvpSchema = normalizePgIdentifier(env.WEB_MVP_SCHEMA || "web_mvp", "WEB_MVP_SCHEMA");
const videoSubmissionsTable = pgRelation("web_video_submissions");
const videoAnalysisJobsTable = pgRelation("web_video_analysis_jobs");

const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const provider = getStorageProvider();
const pythonBin = env.VIDEO_ANALYSIS_PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const analyzerScriptPath = path.resolve(
  process.cwd(),
  env.VIDEO_ANALYSIS_SCRIPT_PATH || "scripts/video_qc/analyze_video.py",
);
const pollIntervalMs = parseBoundedInteger(env.VIDEO_ANALYSIS_POLL_INTERVAL_MS, 5_000, 1_000, 60_000);
const downloadUrlExpiresIn = parseBoundedInteger(
  env.VIDEO_ANALYSIS_DOWNLOAD_URL_EXPIRES_IN,
  3_600,
  300,
  43_200,
);
const analysisProvider = parseAnalysisProvider(env.VIDEO_ANALYSIS_PROVIDER);
const sampleFps = parseBoundedNumber(env.VIDEO_ANALYSIS_SAMPLE_FPS, 3, 0.5, 12);
const minWindowHitRatio = parseBoundedNumber(env.VIDEO_ANALYSIS_MIN_WINDOW_HIT_RATIO, 0.67, 0.34, 1);
const passRatio = parseBoundedNumber(env.VIDEO_ANALYSIS_PASS_RATIO, 0.8, 0.5, 1);
const reviewRatio = parseBoundedNumber(env.VIDEO_ANALYSIS_REVIEW_RATIO, 0.7, 0.3, 1);
const analysisTimeoutMs = parseBoundedInteger(env.VIDEO_ANALYSIS_TIMEOUT_MS, 20 * 60 * 1000, 30_000, 60 * 60 * 1000);
const workerRole = "legacy-video-analysis";
const workerEntry = "workers/video-analysis-runner.mjs";

if (!env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}
if (!provider) {
  throw new Error("Object storage is not configured for video analysis");
}
if (!existsSync(analyzerScriptPath)) {
  throw new Error(`Analyzer script not found: ${analyzerScriptPath}`);
}

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
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseBoundedNumber(raw, fallback, min, max) {
  const parsed = Number.parseFloat(raw || "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseAnalysisProvider(raw) {
  if (raw === "gemini" || raw === "hybrid") {
    return raw;
  }
  return "mediapipe";
}

function getStorageProvider() {
  const hasR2 =
    env.CLOUDFLARE_R2_ACCOUNT_ID &&
    env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
    env.CLOUDFLARE_R2_SECRET_ACCESS_KEY &&
    env.CLOUDFLARE_R2_BUCKET;
  if (hasR2) {
    return "cloudflare_r2";
  }
  const hasCos = env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_REGION && env.COS_BUCKET;
  if (hasCos) {
    return "tencent_cos";
  }
  return null;
}

function getStorageBucket() {
  return provider === "cloudflare_r2" ? env.CLOUDFLARE_R2_BUCKET : env.COS_BUCKET;
}

function getStorageClient() {
  if (storageClient) {
    return storageClient;
  }
  if (provider === "cloudflare_r2") {
    storageClient = new S3Client({
      region: "auto",
      endpoint: `https://${env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  } else {
    storageClient = new S3Client({
      region: env.COS_REGION,
      endpoint: `https://cos.${env.COS_REGION}.myqcloud.com`,
      credentials: {
        accessKeyId: env.COS_SECRET_ID,
        secretAccessKey: env.COS_SECRET_KEY,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }
  return storageClient;
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

async function claimNextJob() {
  const result = await getDbPool().query(
    `with candidate as (
       select id
       from ${videoAnalysisJobsTable}
       where status = 'pending'
       order by id asc
       for update skip locked
       limit 1
     )
     update ${videoAnalysisJobsTable} as jobs
     set status = 'running',
         attempts = jobs.attempts + 1,
         worker_id = $1,
         last_error = null,
         started_at = now(),
         completed_at = null,
         updated_at = now()
     from candidate
     where jobs.id = candidate.id
     returning jobs.*`,
    [workerId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  await getDbPool().query(
    `update ${videoSubmissionsTable}
     set analysis_status = 'running',
         analysis_summary = null,
         analysis_started_at = now(),
         analysis_completed_at = null
     where id = $1`,
    [row.submission_id],
  );
  return row;
}

async function createDownloadUrl(objectKey) {
  return getSignedUrl(
    getStorageClient(),
    new GetObjectCommand({
      Bucket: getStorageBucket(),
      Key: objectKey,
    }),
    { expiresIn: downloadUrlExpiresIn },
  );
}

function buildAnalyzerArgs(downloadUrl) {
  return [
    analyzerScriptPath,
    "--input-url",
    downloadUrl,
    "--provider",
    analysisProvider,
    "--sample-fps",
    String(sampleFps),
    "--min-window-hit-ratio",
    String(minWindowHitRatio),
    "--pass-ratio",
    String(passRatio),
    "--review-ratio",
    String(reviewRatio),
  ];
}

async function runAnalyzer(downloadUrl) {
  return new Promise((resolve, reject) => {
    const args = buildAnalyzerArgs(downloadUrl);
    const child = spawn(pythonBin, args, {
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
      child.kill("SIGKILL");
      finished = true;
      reject(new Error(`Analyzer timed out after ${analysisTimeoutMs} ms`));
    }, analysisTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.on("error", (error) => {
      if (finished) {
        return;
      }
      clearTimeout(timeout);
      finished = true;
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      clearTimeout(timeout);
      finished = true;

      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code !== 0) {
        reject(
          new Error(
            [
              `Analyzer exited with code ${code}${signal ? ` (${signal})` : ""}`,
              stderrText ? `stderr: ${stderrText}` : "",
              stdoutText ? `stdout: ${stdoutText}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
          ),
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdoutText);
        resolve(parsed);
      } catch (error) {
        reject(
          new Error(
            `Analyzer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

function buildSuccessSummary(result) {
  const decision = String(result.decision ?? "review_needed");
  const ratio = Number.isFinite(Number(result.ratio)) ? Number(result.ratio) : null;
  const percent = ratio === null ? "unknown" : `${(ratio * 100).toFixed(1)}%`;
  const reason = typeof result.reason === "string" && result.reason.trim() ? result.reason.trim() : null;
  return reason ? `${decision}: ${reason} (${percent})` : `${decision}: dual-hand ratio ${percent}`;
}

async function markJobSucceeded(job, result) {
  const payload = JSON.stringify(normalizeJsonObject(result));
  const ratio = Number.isFinite(Number(result.ratio)) ? Number(result.ratio) : null;
  const decision = typeof result.decision === "string" ? result.decision : null;
  const summary = buildSuccessSummary(result);

  await getDbPool().query(
    `update ${videoAnalysisJobsTable}
     set status = 'succeeded',
         result_json = $1::jsonb,
         completed_at = now(),
         updated_at = now()
     where id = $2`,
    [payload, job.id],
  );

  await getDbPool().query(
    `update ${videoSubmissionsTable}
     set analysis_status = 'succeeded',
         analysis_decision = $1,
         analysis_ratio = $2,
         analysis_summary = $3,
         analysis_payload = $4::jsonb,
         analysis_completed_at = now()
     where id = $5`,
    [decision, ratio, summary, payload, job.submission_id],
  );
}

async function markJobFailed(job, error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = JSON.stringify({ error: message });

  await getDbPool().query(
    `update ${videoAnalysisJobsTable}
     set status = 'failed',
         last_error = $1,
         result_json = $2::jsonb,
         completed_at = now(),
         updated_at = now()
     where id = $3`,
    [message.slice(0, 4000), payload, job.id],
  );

  await getDbPool().query(
    `update ${videoSubmissionsTable}
     set analysis_status = 'failed',
         analysis_summary = $1,
         analysis_payload = $2::jsonb,
         analysis_completed_at = now()
     where id = $3`,
    [message.slice(0, 4000), payload, job.submission_id],
  );
}

async function processJob(job) {
  console.info("video analysis job started", {
    workerId,
    jobId: job.id,
    submissionId: job.submission_id,
    objectKey: job.object_key,
    analysisProvider,
  });

  const downloadUrl = await createDownloadUrl(job.object_key);
  const result = await runAnalyzer(downloadUrl);
  await markJobSucceeded(job, result);

  console.info("video analysis job completed", {
    workerId,
    jobId: job.id,
    submissionId: job.submission_id,
    analysisProvider,
    decision: result?.decision ?? null,
    ratio: result?.ratio ?? null,
  });
}

async function runLoop() {
  logWorkerRuntimeStarted({
    role: workerRole,
    entry: workerEntry,
    workerId,
    extra: {
      provider,
      analysisProvider,
      pollIntervalMs,
    },
  });
  console.info("video analysis worker started", {
    workerId,
    provider,
    analysisProvider,
    pythonBin,
    analyzerScriptPath,
    pollIntervalMs,
  });

  while (!shuttingDown) {
    const job = await claimNextJob();
    if (!job) {
      await sleep(pollIntervalMs);
      continue;
    }

    try {
      await processJob(job);
    } catch (error) {
      console.error("video analysis job failed", {
        workerId,
        jobId: job.id,
        submissionId: job.submission_id,
        message: error instanceof Error ? error.message : String(error),
      });
      await markJobFailed(job, error);
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
  console.info("video analysis worker shutting down", { workerId, signal });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

runLoop().catch((error) => {
  console.error("video analysis worker crashed", {
    workerId,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
