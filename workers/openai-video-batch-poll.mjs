import { randomUUID } from "node:crypto";
import os from "node:os";

import pg from "pg";

import { logWorkerRuntimeShutdown, logWorkerRuntimeStarted } from "./_runtime.mjs";

const { Pool } = pg;

const env = {
  DATABASE_URL: readEnv("DATABASE_URL"),
  OPENAI_API_KEY: readEnv("OPENAI_API_KEY"),
  OPENAI_VIDEO_BATCH_POLL_INTERVAL_MS: readEnv("OPENAI_VIDEO_BATCH_POLL_INTERVAL_MS"),
  OPENAI_VIDEO_REVIEW_MAX_SUBMIT_ATTEMPTS: readEnv("OPENAI_VIDEO_REVIEW_MAX_SUBMIT_ATTEMPTS"),
};

const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const pollIntervalMs = parseBoundedInteger(env.OPENAI_VIDEO_BATCH_POLL_INTERVAL_MS, 60_000, 10_000, 10 * 60_000);
const maxSubmitAttempts = parseBoundedInteger(env.OPENAI_VIDEO_REVIEW_MAX_SUBMIT_ATTEMPTS, 3, 1, 10);
const workerRole = "openai-video-batch-poll";
const workerEntry = "workers/openai-video-batch-poll.mjs";

let dbPool = null;
let shuttingDown = false;

function readEnv(name) {
  return process.env[name]?.trim() ?? "";
}

function parseBoundedInteger(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function openaiFetch(pathname, init = {}) {
  const response = await fetch(`https://api.openai.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI ${pathname} failed: ${response.status} ${text.slice(0, 1000)}`);
  }
  return response;
}

async function openaiJson(pathname) {
  const response = await openaiFetch(pathname);
  return response.json();
}

async function openaiText(pathname) {
  const response = await openaiFetch(pathname);
  return response.text();
}

async function listActiveBatches() {
  const result = await getDbPool().query(
    `select *
     from public.openai_video_review_batches
     where openai_batch_id is not null
       and status in ('submitted', 'validating', 'in_progress', 'finalizing')
     order by id asc
     limit 20`,
  );
  return result.rows;
}

function normalizeBatchStatus(openaiStatus) {
  if (openaiStatus === "completed") {
    return "completed";
  }
  if (openaiStatus === "failed") {
    return "failed";
  }
  if (openaiStatus === "expired") {
    return "expired";
  }
  if (openaiStatus === "cancelled" || openaiStatus === "canceled") {
    return "cancelled";
  }
  if (openaiStatus === "validating" || openaiStatus === "in_progress" || openaiStatus === "finalizing") {
    return openaiStatus;
  }
  return "submitted";
}

function extractOutputText(responseBody) {
  if (typeof responseBody?.output_text === "string") {
    return responseBody.output_text;
  }
  const pieces = [];
  for (const output of responseBody?.output ?? []) {
    for (const content of output?.content ?? []) {
      if (typeof content?.text === "string") {
        pieces.push(content.text);
      }
      if (typeof content?.json === "object") {
        pieces.push(JSON.stringify(content.json));
      }
    }
  }
  return pieces.join("\n").trim();
}

function parseReviewJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("Empty model output");
  }
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
    : trimmed;
  return JSON.parse(unfenced);
}

function normalizeDecision(value) {
  const decision = String(value ?? "review_needed").trim();
  return decision === "auto_pass" || decision === "auto_reject" || decision === "review_needed"
    ? decision
    : "review_needed";
}

function normalizeRatio(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(1, parsed));
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runStep(step, context, action) {
  try {
    return await action();
  } catch (error) {
    const details = Object.entries(context)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    throw new Error(`${step} failed${details ? ` (${details})` : ""}: ${getErrorMessage(error)}`);
  }
}

async function markBatchStatus(batch, openaiBatch, status, lastError = null) {
  await getDbPool().query(
    `update public.openai_video_review_batches
     set status = $1::text,
         output_file_id = $2::text,
         error_file_id = $3::text,
         last_error = $4::text,
         completed_at = case when $1::text in ('completed', 'failed', 'expired', 'cancelled') then now() else completed_at end,
         updated_at = now()
     where id = $5::bigint`,
    [
      status,
      openaiBatch.output_file_id ?? null,
      openaiBatch.error_file_id ?? null,
      lastError,
      batch.id,
    ],
  );
}

async function updateBatchSubmissionsPolling(batch, status) {
  const payload = JSON.stringify({
    provider: "openai_batch",
    stage: "polling",
    batch_id: batch.id,
    openai_batch_id: batch.openai_batch_id,
    batch_status: status,
  });
  await getDbPool().query(
    `update public.video_submissions s
     set analysis_status = 'polling',
         analysis_summary = 'Polling OpenAI Batch results',
         analysis_payload = $1::jsonb
     from public.openai_video_review_batch_items i
     where i.submission_id = s.id
       and i.batch_id = $2::bigint
       and i.status in ('queued', 'submitted')`,
    [payload, batch.id],
  );
}

async function markSubmissionRetryOrTerminal(submissionId, customId, errorPayload) {
  const errorText = JSON.stringify(errorPayload).slice(0, 4000);
  const payload = JSON.stringify({
    provider: "openai_batch",
    stage: "poll_failed",
    custom_id: customId,
    error: errorText,
  });
  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = case
           when submit_attempt >= $2::integer then 'failed_terminal'
           else 'retry_pending'
         end,
         poll_attempt = poll_attempt + 1,
         analysis_summary = $3::text,
         analysis_payload = $4::jsonb,
         last_error = $3::text,
         openai_batch_id = null,
         openai_custom_id = null,
         lease_owner = null,
         lease_expires_at = null,
         analysis_completed_at = case
           when submit_attempt >= $2::integer then now()
           else null
         end
     where id = $1::bigint`,
    [submissionId, maxSubmitAttempts, errorText, payload],
  );
}

async function handleSuccessLine(line) {
  const customId = line.custom_id;
  const body = line.response?.body;
  const outputText = extractOutputText(body);
  const parsed = parseReviewJson(outputText);
  const decision = normalizeDecision(parsed.decision);
  const ratio = normalizeRatio(parsed.ratio);
  const summary = String(parsed.final_conclusion_cn ?? parsed.summary ?? decision).slice(0, 4000);
  const payload = {
    provider: "openai_batch",
    stage: "completed",
    custom_id: customId,
    model_response: body,
    review: parsed,
  };

  const itemResult = await getDbPool().query(
    `update public.openai_video_review_batch_items
     set status = 'succeeded',
         result_json = $1::jsonb,
         last_error = null,
         completed_at = now(),
         updated_at = now()
     where custom_id = $2::text
     returning submission_id`,
    [JSON.stringify(payload), customId],
  );
  const submissionId = itemResult.rows[0]?.submission_id;
  if (!submissionId) {
    console.warn("openai batch result custom_id not found", { customId });
    return;
  }

  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = 'completed',
         analysis_decision = $1::text,
         analysis_ratio = $2::double precision,
         analysis_summary = $3::text,
         analysis_payload = $4::jsonb,
         last_error = null,
         lease_owner = null,
         lease_expires_at = null,
         analysis_completed_at = now()
     where id = $5::bigint`,
    [decision, ratio, summary, JSON.stringify(payload), submissionId],
  );
}

async function handleFailedLine(line) {
  const customId = line.custom_id;
  const errorText = JSON.stringify(line.error ?? line.response ?? line).slice(0, 4000);
  const itemResult = await getDbPool().query(
    `update public.openai_video_review_batch_items
     set status = 'failed',
         last_error = $1::text,
         completed_at = now(),
         updated_at = now()
     where custom_id = $2::text
     returning submission_id`,
    [errorText, customId],
  );
  const submissionId = itemResult.rows[0]?.submission_id;
  if (submissionId) {
    await markSubmissionRetryOrTerminal(submissionId, customId, line);
  }
}

async function processResultFile(fileId, mode) {
  const text = await openaiText(`/v1/files/${encodeURIComponent(fileId)}/content`);
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    const line = JSON.parse(trimmed);
    if (mode === "error" || line.error || line.response?.status_code >= 400) {
      await handleFailedLine(line);
      continue;
    }
    try {
      await handleSuccessLine(line);
    } catch (error) {
      await handleFailedLine({
        ...line,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

async function handleBatchTerminalFailure(batch, openaiBatch, status) {
  const errorText = JSON.stringify(openaiBatch.errors ?? openaiBatch).slice(0, 4000);
  await markBatchStatus(batch, openaiBatch, status, errorText);

  const result = await getDbPool().query(
    `update public.openai_video_review_batch_items
     set status = 'failed',
         last_error = $1::text,
         completed_at = now(),
         updated_at = now()
     where batch_id = $2::bigint
       and status in ('queued', 'submitted')
     returning submission_id, custom_id`,
    [errorText, batch.id],
  );

  for (const row of result.rows) {
    await markSubmissionRetryOrTerminal(row.submission_id, row.custom_id, {
      batch_status: status,
      error: errorText,
    });
  }
}

async function pollOnce() {
  const batches = await listActiveBatches();
  for (const batch of batches) {
    const openaiBatch = await openaiJson(`/v1/batches/${encodeURIComponent(batch.openai_batch_id)}`);
    const status = normalizeBatchStatus(openaiBatch.status);
    console.info("openai video batch polled", {
      batchId: batch.id,
      openaiBatchId: batch.openai_batch_id,
      status,
    });

    if (status === "completed") {
      if (openaiBatch.output_file_id) {
        await runStep(
          "processResultFile",
          { batchId: batch.id, openaiBatchId: batch.openai_batch_id, fileId: openaiBatch.output_file_id, mode: "output" },
          () => processResultFile(openaiBatch.output_file_id, "output"),
        );
      }
      if (openaiBatch.error_file_id) {
        await runStep(
          "processResultFile",
          { batchId: batch.id, openaiBatchId: batch.openai_batch_id, fileId: openaiBatch.error_file_id, mode: "error" },
          () => processResultFile(openaiBatch.error_file_id, "error"),
        );
      }
      await runStep(
        "markBatchStatus",
        { batchId: batch.id, openaiBatchId: batch.openai_batch_id, status },
        () => markBatchStatus(batch, openaiBatch, status),
      );
      continue;
    }

    if (status === "failed" || status === "expired" || status === "cancelled") {
      await runStep(
        "handleBatchTerminalFailure",
        { batchId: batch.id, openaiBatchId: batch.openai_batch_id, status },
        () => handleBatchTerminalFailure(batch, openaiBatch, status),
      );
      continue;
    }

    await runStep(
      "markBatchStatus",
      { batchId: batch.id, openaiBatchId: batch.openai_batch_id, status },
      () => markBatchStatus(batch, openaiBatch, status),
    );
    await runStep(
      "updateBatchSubmissionsPolling",
      { batchId: batch.id, openaiBatchId: batch.openai_batch_id, status },
      () => updateBatchSubmissionsPolling(batch, status),
    );
  }
}

async function runLoop() {
  requireEnv("DATABASE_URL", env.DATABASE_URL);
  requireEnv("OPENAI_API_KEY", env.OPENAI_API_KEY);
  logWorkerRuntimeStarted({
    role: workerRole,
    entry: workerEntry,
    workerId,
    extra: {
      pollIntervalMs,
      maxSubmitAttempts,
    },
  });
  console.info("openai video batch poll worker started", {
    workerId,
    pollIntervalMs,
  });
  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (error) {
      console.error("openai video batch poll failed", {
        workerId,
        message: getErrorMessage(error),
      });
    }
    await sleep(pollIntervalMs);
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
  console.info("openai video batch poll worker shutting down", { workerId, signal });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

runLoop()
  .catch((error) => {
    console.error("openai video batch poll worker crashed", {
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
