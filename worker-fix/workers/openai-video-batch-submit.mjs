import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";

import { logWorkerRuntimeStarted } from "./_runtime.mjs";

const { Pool } = pg;

const env = {
  DATABASE_URL: readEnv("DATABASE_URL"),
  OPENAI_API_KEY: readEnv("OPENAI_API_KEY"),
  OPENAI_VIDEO_REVIEW_MODEL: readEnv("OPENAI_VIDEO_REVIEW_MODEL"),
  OPENAI_VIDEO_BATCH_LIMIT: readEnv("OPENAI_VIDEO_BATCH_LIMIT"),
  OPENAI_VIDEO_BATCH_MIN_SUBMISSION_ID: readEnv("OPENAI_VIDEO_BATCH_MIN_SUBMISSION_ID"),
  OPENAI_VIDEO_REVIEW_IMAGE_URL_EXPIRES_IN: readEnv("OPENAI_VIDEO_REVIEW_IMAGE_URL_EXPIRES_IN"),
  OPENAI_VIDEO_REVIEW_CONTACT_SHEET_PREFIX: readEnv("OPENAI_VIDEO_REVIEW_CONTACT_SHEET_PREFIX"),
  OPENAI_VIDEO_REVIEW_MAX_SUBMIT_ATTEMPTS: readEnv("OPENAI_VIDEO_REVIEW_MAX_SUBMIT_ATTEMPTS"),
  COS_SECRET_ID: readEnv("COS_SECRET_ID"),
  COS_SECRET_KEY: readEnv("COS_SECRET_KEY"),
  COS_REGION: readEnv("COS_REGION"),
};

const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const model = env.OPENAI_VIDEO_REVIEW_MODEL || "gpt-4.1-mini";
const batchLimit = parseBoundedInteger(env.OPENAI_VIDEO_BATCH_LIMIT, 20, 1, 200);
const minSubmissionId = parseBoundedInteger(env.OPENAI_VIDEO_BATCH_MIN_SUBMISSION_ID, 0, 0, Number.MAX_SAFE_INTEGER);
const imageUrlExpiresIn = parseBoundedInteger(
  env.OPENAI_VIDEO_REVIEW_IMAGE_URL_EXPIRES_IN,
  48 * 60 * 60,
  3600,
  7 * 24 * 60 * 60,
);
const maxSubmitAttempts = parseBoundedInteger(env.OPENAI_VIDEO_REVIEW_MAX_SUBMIT_ATTEMPTS, 3, 1, 10);
const contactSheetPrefix = env.OPENAI_VIDEO_REVIEW_CONTACT_SHEET_PREFIX || "contact-sheet/";
const leaseMinutes = 15;
const activeBatchStatuses = new Set(["submitted", "validating", "in_progress", "finalizing", "completed"]);
const workerRole = "openai-video-batch-submit";
const workerEntry = "workers/openai-video-batch-submit.mjs";

let dbPool = null;
let storageClient = null;

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

function normalizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { sheets: [] };
  }
  return value;
}

function getSheetsFromManifest(manifest) {
  const normalized = normalizeManifest(manifest);
  const sheets = Array.isArray(normalized.sheets) ? normalized.sheets : [];
  return sheets
    .map((sheet, index) => {
      const objectKey = String(sheet?.object_key ?? "").trim();
      const bucket = String(sheet?.bucket ?? "").trim();
      const region = String(sheet?.region ?? env.COS_REGION).trim();
      if (!objectKey || !bucket || !region) {
        return null;
      }
      return {
        segmentIndex: Number.isInteger(sheet?.segment_index) ? sheet.segment_index : index,
        objectKey,
        bucket,
        region,
        timePointsSec: Array.isArray(sheet?.time_points_sec) ? sheet.time_points_sec : [],
      };
    })
    .filter(Boolean);
}

function buildReviewPrompt(submission, sheetCount) {
  return [
    "You are reviewing egocentric robot-training footage from one video.",
    `Submission id: ${submission.id}`,
    `Participant code: ${submission.participant_code || ""}`,
    `File name: ${submission.file_name || ""}`,
    `Duration metadata (seconds): ${submission.duration_sec || ""}`,
    `Contact sheet count: ${sheetCount}`,
    "The images are ordered by time, and each cell contains a timestamp overlay.",
    "Judge whether both hands stay visible and usable for learning, whether the footage is egocentric, and whether clarity/FOV are sufficient.",
    "Return strict JSON only with keys: decision, ratio, confidence, summary, basic_info, hand_visibility, issue_timeline, hard_fail_reasons, final_conclusion_cn.",
  ].join("\n");
}

function buildBatchRequestLine(item, imageUrls, submission) {
  return {
    custom_id: item.custom_id,
    method: "POST",
    url: "/v1/responses",
    body: {
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildReviewPrompt(submission, imageUrls.length),
            },
            ...imageUrls.map((imageUrl) => ({
              type: "input_image",
              image_url: imageUrl,
              detail: "high",
            })),
          ],
        },
      ],
    },
  };
}

async function openaiJson(pathname, init = {}) {
  const response = await fetch(`https://api.openai.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`OpenAI ${pathname} failed: ${response.status} ${text.slice(0, 1000)}`);
  }
  return payload;
}

async function createSignedGetUrl(bucket, objectKey) {
  if (!objectKey.startsWith(contactSheetPrefix)) {
    throw new Error(`Refusing to sign non-contact-sheet object: ${objectKey}`);
  }
  return getSignedUrl(
    getStorageClient(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }),
    { expiresIn: imageUrlExpiresIn },
  );
}

async function uploadOpenAiBatchFile(filePath) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([bytes], { type: "application/jsonl" }), path.basename(filePath));
  return openaiJson("/v1/files", {
    method: "POST",
    body: form,
  });
}

async function createOpenAiBatch(inputFileId) {
  return openaiJson("/v1/batches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: "/v1/responses",
      completion_window: "24h",
      metadata: {
        worker_id: workerId,
        purpose: "wechat-video-review",
      },
    }),
  });
}

async function markAbandonedLocalBatches() {
  await getDbPool().query(
    `update public.openai_video_review_batches
     set status = 'failed',
         last_error = coalesce(last_error, 'Local submit interrupted before OpenAI Batch was created.'),
         completed_at = coalesce(completed_at, now()),
         updated_at = now()
     where status = 'preparing'
       and openai_batch_id is null
       and updated_at < now() - interval '10 minutes'`,
  );
}

async function claimTargets() {
  const result = await getDbPool().query(
    `with candidate as (
       select s.id
       from public.video_submissions s
       where s.id >= $2::bigint
         and coalesce(s.analysis_status, 'queued') in ('preprocess_ready', 'retry_pending', 'submit_pending')
         and coalesce(s.contact_sheet_count, 0) > 0
         and coalesce(s.submit_attempt, 0) < $3::integer
         and (s.lease_expires_at is null or s.lease_expires_at < now())
         and not exists (
           select 1
           from public.openai_video_review_batch_items i
           left join public.openai_video_review_batches b
             on b.id = i.batch_id
           where i.submission_id = s.id
             and coalesce(i.preprocess_version, -1) = coalesce(s.preprocess_version, -1)
             and (
               i.status = 'succeeded'
               or (i.status = 'submitted' and b.status in ('submitted', 'validating', 'in_progress', 'finalizing', 'completed'))
               or (i.status = 'queued' and b.status = 'preparing')
             )
         )
       order by s.id asc
       for update skip locked
       limit $1::integer
     )
     update public.video_submissions s
     set analysis_status = 'submit_pending',
         lease_owner = $4::text,
         lease_expires_at = now() + make_interval(mins => $5::integer)
     from candidate
     where s.id = candidate.id
     returning s.*`,
    [batchLimit, minSubmissionId, maxSubmitAttempts, workerId, leaseMinutes],
  );
  return result.rows;
}

async function createLocalBatch() {
  const result = await getDbPool().query(
    `insert into public.openai_video_review_batches (status, model, worker_id)
     values ('preparing', $1::text, $2::text)
     returning *`,
    [model, workerId],
  );
  return result.rows[0];
}

async function findReusableBatchItem(submissionId, preprocessVersion) {
  const result = await getDbPool().query(
    `select i.*
     from public.openai_video_review_batch_items i
     left join public.openai_video_review_batches b
       on b.id = i.batch_id
     where i.submission_id = $1::bigint
       and coalesce(i.preprocess_version, -1) = $2::integer
       and i.status in ('queued', 'failed')
       and (
         b.openai_batch_id is null
         or b.status in ('preparing', 'failed', 'expired', 'cancelled')
       )
     order by i.updated_at desc, i.id desc
     limit 1`,
    [submissionId, preprocessVersion],
  );
  return result.rows[0] ?? null;
}

async function findBatchItemByCustomId(customId) {
  const result = await getDbPool().query(
    `select i.*,
            b.status as batch_status,
            b.openai_batch_id
     from public.openai_video_review_batch_items i
     left join public.openai_video_review_batches b
       on b.id = i.batch_id
     where i.custom_id = $1::text
     limit 1`,
    [customId],
  );
  return result.rows[0] ?? null;
}

function isReusableBatchItem(item) {
  if (!item || item.status === "succeeded") {
    return false;
  }
  if (item.status === "submitted" && !["failed", "expired", "cancelled"].includes(item.batch_status)) {
    return false;
  }
  if (!["queued", "failed", "submitted"].includes(item.status)) {
    return false;
  }
  return !item.openai_batch_id || ["preparing", "failed", "expired", "cancelled"].includes(item.batch_status);
}

function isActiveBatchItem(item) {
  if (!item) {
    return false;
  }
  if (item.status === "succeeded") {
    return true;
  }
  if (item.status === "submitted" && activeBatchStatuses.has(item.batch_status)) {
    return true;
  }
  return item.status === "queued" && item.batch_status === "preparing";
}

async function insertBatchItem(batchId, submission, customId, imageObjectKeys) {
  const firstKey = imageObjectKeys[0] ?? null;
  try {
    const result = await getDbPool().query(
      `insert into public.openai_video_review_batch_items (
         batch_id,
         submission_id,
         custom_id,
         image_object_key,
         image_object_keys,
         preprocess_version,
         sheet_count,
         status
       ) values ($1::bigint, $2::bigint, $3::text, $4::text, $5::jsonb, $6::integer, $7::integer, 'queued')
       returning *`,
      [
        batchId,
        submission.id,
        customId,
        firstKey,
        JSON.stringify(imageObjectKeys),
        submission.preprocess_version,
        imageObjectKeys.length,
      ],
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code !== "23505") {
      throw error;
    }
    return findBatchItemByCustomId(customId);
  }
}

async function requeueBatchItem(itemId, batchId) {
  const result = await getDbPool().query(
    `update public.openai_video_review_batch_items
     set batch_id = $1::bigint,
         status = 'queued',
         last_error = null,
         completed_at = null,
         updated_at = now()
     where id = $2::bigint
     returning *`,
    [batchId, itemId],
  );
  return result.rows[0];
}

async function releaseSubmissionForLater(submissionId, summary) {
  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = 'submit_pending',
         analysis_summary = $2::text,
         lease_owner = null,
         lease_expires_at = null
     where id = $1::bigint`,
    [submissionId, summary],
  );
}

async function markSubmissionAlreadySubmitted(submissionId, item) {
  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = 'submitted',
         openai_batch_id = $2::text,
         openai_custom_id = $3::text,
         analysis_summary = 'Already submitted to OpenAI Batch',
         analysis_payload = jsonb_build_object(
           'provider', 'openai_batch',
           'stage', 'already_submitted',
           'batch_id', $4::bigint,
           'openai_batch_id', $2::text,
           'custom_id', $3::text,
           'preprocess_version', $5::integer
         ),
         last_error = null,
         lease_owner = null,
         lease_expires_at = null
     where id = $1::bigint`,
    [submissionId, item.openai_batch_id, item.custom_id, item.batch_id, item.preprocess_version],
  );
}

async function markSubmissionRetryState(submissionId, errorText, terminal = false) {
  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = case
           when coalesce(submit_attempt, 0) + 1 >= ($2::integer) or $4::boolean then 'failed_terminal'
           else 'retry_pending'
         end,
         submit_attempt = coalesce(submit_attempt, 0) + 1,
         analysis_summary = $3::text,
         analysis_payload = jsonb_build_object(
           'provider', 'openai_batch',
           'stage', 'submit_failed',
           'error', $3::text
         ),
         last_error = $3::text,
         lease_owner = null,
         lease_expires_at = null,
         analysis_completed_at = case
           when coalesce(submit_attempt, 0) + 1 >= ($2::integer) or $4::boolean then now()
           else null
         end
     where id = $1::bigint`,
    [submissionId, maxSubmitAttempts, String(errorText).slice(0, 4000), terminal],
  );
}

async function markSubmissionSubmitted(submissionId, batch, item) {
  await getDbPool().query(
    `update public.video_submissions
     set analysis_status = 'submitted',
         openai_batch_id = $2::text,
         openai_custom_id = $3::text,
         submit_attempt = coalesce(submit_attempt, 0) + 1,
         analysis_summary = 'Submitted to OpenAI Batch',
         analysis_payload = jsonb_build_object(
           'provider', 'openai_batch',
           'stage', 'submitted',
           'batch_id', $4::bigint,
           'openai_batch_id', $2::text,
           'custom_id', $3::text,
           'preprocess_version', $5::integer
         ),
         last_error = null,
         lease_owner = null,
         lease_expires_at = null
     where id = $1::bigint`,
    [submissionId, batch.openai_batch_id, item.custom_id, batch.id, item.preprocess_version],
  );
}

function buildDeterministicCustomId(submission) {
  return `${submission.id}:${submission.preprocess_version}:sheet-v1:${model}`;
}

async function resolveBatchItemForSubmission(batch, submission, imageObjectKeys) {
  const customId = buildDeterministicCustomId(submission);
  const reusableItem =
    (await findBatchItemByCustomId(customId)) ??
    (await findReusableBatchItem(submission.id, submission.preprocess_version));

  if (reusableItem) {
    if (isReusableBatchItem(reusableItem)) {
      return requeueBatchItem(reusableItem.id, batch.id);
    }
    if (reusableItem.openai_batch_id && reusableItem.status === "submitted") {
      await markSubmissionAlreadySubmitted(submission.id, reusableItem);
    } else {
      await releaseSubmissionForLater(
        submission.id,
        `Skipped submit because custom_id is already owned by batch item ${reusableItem.id}`,
      );
    }
    console.info("openai video batch submit skipped existing batch item", {
      submissionId: submission.id,
      customId,
      itemId: reusableItem.id,
      itemStatus: reusableItem.status,
      batchStatus: reusableItem.batch_status,
      openaiBatchId: reusableItem.openai_batch_id,
    });
    return null;
  }

  const insertedItem = await insertBatchItem(batch.id, submission, customId, imageObjectKeys);
  if (!insertedItem) {
    await releaseSubmissionForLater(submission.id, `Skipped submit because custom_id already exists: ${customId}`);
    return null;
  }
  if (Number(insertedItem.batch_id) === Number(batch.id) && insertedItem.status === "queued") {
    return insertedItem;
  }
  if (isReusableBatchItem(insertedItem)) {
    return requeueBatchItem(insertedItem.id, batch.id);
  }
  if (insertedItem.openai_batch_id && insertedItem.status === "submitted") {
    await markSubmissionAlreadySubmitted(submission.id, insertedItem);
  } else {
    await releaseSubmissionForLater(
      submission.id,
      `Skipped submit because custom_id is already owned by batch item ${insertedItem.id}`,
    );
  }
  console.info("openai video batch submit skipped duplicate custom_id", {
    submissionId: submission.id,
    customId,
    itemId: insertedItem.id,
    itemStatus: insertedItem.status,
    batchId: insertedItem.batch_id,
  });
  return null;
}

async function prepareSubmissionForBatch(batch, submission) {
  const sheets = getSheetsFromManifest(submission.contact_sheet_manifest_json);
  if (sheets.length === 0) {
    throw new Error(`Submission ${submission.id} has no contact sheets in manifest`);
  }

  const imageUrls = await Promise.all(
    sheets.map((sheet) => createSignedGetUrl(sheet.bucket, sheet.objectKey)),
  );
  const imageObjectKeys = sheets.map((sheet) => sheet.objectKey);
  const item = await resolveBatchItemForSubmission(batch, submission, imageObjectKeys);
  if (!item) {
    return null;
  }

  return {
    submission,
    item,
    line: JSON.stringify(buildBatchRequestLine(item, imageUrls, submission)),
  };
}

async function submitBatch() {
  requireEnv("DATABASE_URL", env.DATABASE_URL);
  requireEnv("OPENAI_API_KEY", env.OPENAI_API_KEY);
  requireEnv("COS_SECRET_ID", env.COS_SECRET_ID);
  requireEnv("COS_SECRET_KEY", env.COS_SECRET_KEY);
  requireEnv("COS_REGION", env.COS_REGION);

  logWorkerRuntimeStarted({
    role: workerRole,
    entry: workerEntry,
    workerId,
    extra: {
      model,
      batchLimit,
      minSubmissionId,
      imageUrlExpiresIn,
      maxSubmitAttempts,
    },
  });
  console.info("openai video batch submit started", {
    workerId,
    model,
    batchLimit,
    minSubmissionId,
    imageUrlExpiresIn,
  });

  await markAbandonedLocalBatches();
  const targets = await claimTargets();
  if (targets.length === 0) {
    console.info("openai video batch submit skipped: no pending preprocess_ready submissions");
    return;
  }

  const batch = await createLocalBatch();
  const workDir = path.join(os.tmpdir(), `openai-video-batch-${batch.id}-${randomUUID().slice(0, 8)}`);
  const prepared = [];
  await mkdir(workDir, { recursive: true });

  try {
    for (const submission of targets) {
      try {
        const entry = await prepareSubmissionForBatch(batch, submission);
        if (entry) {
          prepared.push(entry);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("openai video batch submit item failed", {
          workerId,
          submissionId: submission.id,
          message,
        });
        await markSubmissionRetryState(submission.id, message);
      }
    }

    if (prepared.length === 0) {
      await markLocalBatchFailed(batch.id, "No eligible batch items after idempotency checks.");
      console.info("openai video batch submit skipped: no eligible batch items", {
        batchId: batch.id,
        targetCount: targets.length,
      });
      return;
    }

    const jsonlPath = path.join(workDir, `openai-video-review-batch-${batch.id}.jsonl`);
    await writeFile(jsonlPath, `${prepared.map((item) => item.line).join("\n")}\n`, "utf8");
    const inputFile = await uploadOpenAiBatchFile(jsonlPath);
    const openaiBatch = await createOpenAiBatch(inputFile.id);

    await getDbPool().query(
      `update public.openai_video_review_batches
       set status = 'submitted',
           openai_batch_id = $1::text,
           input_file_id = $2::text,
           request_count = $3::integer,
           submitted_at = now(),
           updated_at = now()
       where id = $4::bigint`,
      [openaiBatch.id, inputFile.id, prepared.length, batch.id],
    );
    batch.openai_batch_id = openaiBatch.id;

    await getDbPool().query(
      `update public.openai_video_review_batch_items
       set status = 'submitted',
           updated_at = now()
       where batch_id = $1::bigint`,
      [batch.id],
    );

    for (const entry of prepared) {
      await markSubmissionSubmitted(entry.submission.id, batch, entry.item);
    }

    console.info("openai video batch submitted", {
      batchId: batch.id,
      openaiBatchId: openaiBatch.id,
      inputFileId: inputFile.id,
      requestCount: prepared.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLocalBatchFailed(batch.id, message);
    const preparedSubmissionIds = new Set(prepared.map((entry) => entry.submission.id));
    for (const submission of targets) {
      if (preparedSubmissionIds.has(submission.id)) {
        await markSubmissionRetryState(submission.id, message);
      } else if (submission.lease_owner === workerId) {
        await releaseSubmissionForLater(submission.id, message);
      }
    }
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function markLocalBatchFailed(batchId, message) {
  await getDbPool().query(
    `update public.openai_video_review_batches
     set status = 'failed',
         last_error = $1::text,
         completed_at = now(),
         updated_at = now()
     where id = $2::bigint`,
    [message.slice(0, 4000), batchId],
  );
}

submitBatch()
  .catch((error) => {
    console.error("openai video batch submit failed", {
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
