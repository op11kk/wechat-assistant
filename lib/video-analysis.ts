import type { QueryResultRow } from "pg";

import { dbQuery, dbQueryMaybeOne } from "@/lib/db";
import { env } from "@/lib/env";

export const VIDEO_ANALYSIS_STATUSES = new Set([
  "queued",
  "preprocessing",
  "preprocess_ready",
  "submit_pending",
  "submitted",
  "polling",
  "completed",
  "retry_pending",
  "failed_terminal",
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export const VIDEO_ANALYSIS_DECISIONS = new Set(["auto_pass", "auto_reject", "review_needed"]);
export const VIDEO_ANALYSIS_JOB_STATUSES = VIDEO_ANALYSIS_STATUSES;

export type VideoAnalysisStatus =
  | "queued"
  | "preprocessing"
  | "preprocess_ready"
  | "submit_pending"
  | "submitted"
  | "polling"
  | "completed"
  | "retry_pending"
  | "failed_terminal"
  | "pending"
  | "running"
  | "succeeded"
  | "failed";
export type VideoAnalysisDecision = "auto_pass" | "auto_reject" | "review_needed";
export type VideoAnalysisJobStatus = VideoAnalysisStatus;

export type VideoAnalysisJobRow = {
  id: number;
  submission_id: number;
  object_key: string;
  status: VideoAnalysisJobStatus;
  attempts: number;
  worker_id: string | null;
  last_error: string | null;
  result_json: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type VideoAnalysisSubmissionRow = {
  id: number;
  object_key: string | null;
  analysis_status: VideoAnalysisStatus | null;
  analysis_decision: VideoAnalysisDecision | null;
  analysis_ratio: number | null;
  analysis_summary: string | null;
  analysis_payload: Record<string, unknown>;
  analysis_started_at: string | null;
  analysis_completed_at: string | null;
  created_at: string;
};

function parseInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected integer but received ${String(value)}`);
  }
  return parsed;
}

function parseNullableInteger(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseFloatNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value: unknown): VideoAnalysisStatus | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  if (raw === "succeeded") {
    return "completed";
  }
  if (raw === "failed") {
    return "failed_terminal";
  }
  return raw as VideoAnalysisStatus;
}

function mapVideoAnalysisSubmissionRow(row: QueryResultRow): VideoAnalysisSubmissionRow {
  return {
    id: parseInteger(row.id),
    object_key: row.object_key ? String(row.object_key) : null,
    analysis_status: normalizeStatus(row.analysis_status),
    analysis_decision: row.analysis_decision ? (String(row.analysis_decision) as VideoAnalysisDecision) : null,
    analysis_ratio: parseFloatNumber(row.analysis_ratio),
    analysis_summary: row.analysis_summary ? String(row.analysis_summary) : null,
    analysis_payload: normalizeJsonObject(row.analysis_payload),
    analysis_started_at: row.analysis_started_at ? String(row.analysis_started_at) : null,
    analysis_completed_at: row.analysis_completed_at ? String(row.analysis_completed_at) : null,
    created_at: String(row.created_at),
  };
}

function mapSubmissionToVirtualJob(row: QueryResultRow): VideoAnalysisJobRow {
  const preprocessVersion = parseNullableInteger(row.preprocess_version) ?? 0;
  const submitAttempt = parseNullableInteger(row.submit_attempt) ?? 0;
  const pollAttempt = parseNullableInteger(row.poll_attempt) ?? 0;

  return {
    id: parseInteger(row.id),
    submission_id: parseInteger(row.id),
    object_key: row.object_key ? String(row.object_key) : "",
    status: normalizeStatus(row.analysis_status) ?? "queued",
    attempts: Math.max(preprocessVersion, 0) + Math.max(submitAttempt, 0) + Math.max(pollAttempt, 0),
    worker_id: row.lease_owner ? String(row.lease_owner) : null,
    last_error: row.last_error ? String(row.last_error) : null,
    result_json: normalizeJsonObject(row.contact_sheet_manifest_json),
    started_at: row.analysis_started_at ? String(row.analysis_started_at) : null,
    completed_at: row.analysis_completed_at ? String(row.analysis_completed_at) : null,
    created_at: String(row.created_at),
    updated_at: row.updated_at ? String(row.updated_at) : String(row.created_at),
  };
}

async function getSubmissionStateRow(submissionId: number): Promise<QueryResultRow | null> {
  return dbQueryMaybeOne(
    `select
       id,
       object_key,
       analysis_status,
       analysis_decision,
       analysis_ratio,
       analysis_summary,
       analysis_payload,
       analysis_started_at,
       analysis_completed_at,
       raw_cos_bucket,
       raw_cos_key,
       raw_cos_region,
       preprocess_version,
       contact_sheet_manifest_json,
       contact_sheet_count,
       submit_attempt,
       poll_attempt,
       last_error,
       lease_owner,
       lease_expires_at,
       created_at,
       now() as updated_at
     from public.video_submissions
     where id = $1
     limit 1`,
    [submissionId],
  );
}

function buildRawStorageLocation(objectKey: string) {
  return {
    rawCosBucket: env.COS_BUCKET || null,
    rawCosKey: objectKey,
    rawCosRegion: env.COS_REGION || null,
  };
}

export async function enqueueVideoAnalysisJob(params: {
  submissionId: number;
  objectKey: string;
}): Promise<VideoAnalysisJobRow> {
  const rawLocation = buildRawStorageLocation(params.objectKey);
  await dbQuery(
    `update public.video_submissions
     set object_key = $2,
         analysis_status = 'queued',
         analysis_decision = null,
         analysis_ratio = null,
         analysis_summary = null,
         analysis_payload = '{}'::jsonb,
         analysis_started_at = null,
         analysis_completed_at = null,
         raw_cos_bucket = coalesce($3, raw_cos_bucket),
         raw_cos_key = $4,
         raw_cos_region = coalesce($5, raw_cos_region),
         contact_sheet_manifest_json = '{}'::jsonb,
         contact_sheet_count = 0,
         openai_batch_id = null,
         openai_custom_id = null,
         submit_attempt = 0,
         poll_attempt = 0,
         last_error = null,
         lease_owner = null,
         lease_expires_at = null
     where id = $1`,
    [
      params.submissionId,
      params.objectKey,
      rawLocation.rawCosBucket,
      rawLocation.rawCosKey,
      rawLocation.rawCosRegion,
    ],
  );

  const row = await getSubmissionStateRow(params.submissionId);
  if (!row) {
    throw new Error(`Submission ${params.submissionId} not found`);
  }
  return mapSubmissionToVirtualJob(row);
}

export async function getVideoAnalysisJobBySubmissionId(
  submissionId: number,
): Promise<VideoAnalysisJobRow | null> {
  const row = await getSubmissionStateRow(submissionId);
  return row ? mapSubmissionToVirtualJob(row) : null;
}

export async function getVideoAnalysisSubmissionById(
  submissionId: number,
): Promise<VideoAnalysisSubmissionRow | null> {
  const row = await dbQueryMaybeOne(
    `select
       id,
       object_key,
       analysis_status,
       analysis_decision,
       analysis_ratio,
       analysis_summary,
       analysis_payload,
       analysis_started_at,
       analysis_completed_at,
       created_at
     from public.video_submissions
     where id = $1
     limit 1`,
    [submissionId],
  );
  return row ? mapVideoAnalysisSubmissionRow(row) : null;
}

export async function requeueVideoAnalysisJobBySubmissionId(
  submissionId: number,
): Promise<VideoAnalysisJobRow | null> {
  const submission = await getVideoAnalysisSubmissionById(submissionId);
  if (!submission?.object_key) {
    return null;
  }
  return enqueueVideoAnalysisJob({
    submissionId,
    objectKey: submission.object_key,
  });
}

export async function listRecentVideoAnalysisStates(limit = 20): Promise<QueryResultRow[]> {
  return dbQuery(
    `select
       s.id as submission_id,
       s.object_key,
       s.analysis_status,
       s.analysis_decision,
       s.analysis_ratio,
       s.analysis_summary,
       s.analysis_started_at,
       s.analysis_completed_at,
       s.preprocess_version,
       s.contact_sheet_count,
       s.openai_batch_id,
       s.openai_custom_id,
       s.submit_attempt,
       s.poll_attempt,
       s.last_error,
       s.lease_owner,
       s.lease_expires_at,
       s.created_at
     from public.video_submissions s
     order by s.id desc
     limit $1`,
    [limit],
  );
}
