import type { QueryResultRow } from "pg";

import { dbQuery, dbQueryMaybeOne, dbQueryOne } from "@/lib/db";

export const VIDEO_ANALYSIS_STATUSES = new Set(["pending", "running", "succeeded", "failed"]);
export const VIDEO_ANALYSIS_DECISIONS = new Set(["auto_pass", "auto_reject", "review_needed"]);
export const VIDEO_ANALYSIS_JOB_STATUSES = new Set(["pending", "running", "succeeded", "failed"]);

export type VideoAnalysisStatus = "pending" | "running" | "succeeded" | "failed";
export type VideoAnalysisDecision = "auto_pass" | "auto_reject" | "review_needed";
export type VideoAnalysisJobStatus = "pending" | "running" | "succeeded" | "failed";

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

function mapVideoAnalysisJobRow(row: QueryResultRow): VideoAnalysisJobRow {
  return {
    id: parseInteger(row.id),
    submission_id: parseInteger(row.submission_id),
    object_key: String(row.object_key),
    status: String(row.status) as VideoAnalysisJobStatus,
    attempts: parseInteger(row.attempts),
    worker_id: row.worker_id ? String(row.worker_id) : null,
    last_error: row.last_error ? String(row.last_error) : null,
    result_json: normalizeJsonObject(row.result_json),
    started_at: row.started_at ? String(row.started_at) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapVideoAnalysisSubmissionRow(row: QueryResultRow): VideoAnalysisSubmissionRow {
  return {
    id: parseInteger(row.id),
    object_key: row.object_key ? String(row.object_key) : null,
    analysis_status: row.analysis_status ? (String(row.analysis_status) as VideoAnalysisStatus) : null,
    analysis_decision: row.analysis_decision
      ? (String(row.analysis_decision) as VideoAnalysisDecision)
      : null,
    analysis_ratio: parseFloatNumber(row.analysis_ratio),
    analysis_summary: row.analysis_summary ? String(row.analysis_summary) : null,
    analysis_payload: normalizeJsonObject(row.analysis_payload),
    analysis_started_at: row.analysis_started_at ? String(row.analysis_started_at) : null,
    analysis_completed_at: row.analysis_completed_at ? String(row.analysis_completed_at) : null,
    created_at: String(row.created_at),
  };
}

async function resetVideoSubmissionAnalysisState(submissionId: number): Promise<void> {
  await dbQuery(
    `update public.video_submissions
     set analysis_status = 'pending',
         analysis_decision = null,
         analysis_ratio = null,
         analysis_summary = null,
         analysis_payload = '{}'::jsonb,
         analysis_started_at = null,
         analysis_completed_at = null
     where id = $1`,
    [submissionId],
  );
}

export async function enqueueVideoAnalysisJob(params: {
  submissionId: number;
  objectKey: string;
}): Promise<VideoAnalysisJobRow> {
  const inserted = await dbQueryMaybeOne(
    `insert into public.video_analysis_jobs (
       submission_id,
       object_key,
       status,
       attempts,
       result_json
     ) values ($1, $2, 'pending', 0, '{}'::jsonb)
     on conflict (submission_id) do nothing
     returning *`,
    [params.submissionId, params.objectKey],
  );

  if (inserted) {
    await resetVideoSubmissionAnalysisState(params.submissionId);
    return mapVideoAnalysisJobRow(inserted);
  }

  const existing = await dbQueryOne(
    `select *
     from public.video_analysis_jobs
     where submission_id = $1
     limit 1`,
    [params.submissionId],
  );
  return mapVideoAnalysisJobRow(existing);
}

export async function getVideoAnalysisJobBySubmissionId(
  submissionId: number,
): Promise<VideoAnalysisJobRow | null> {
  const row = await dbQueryMaybeOne(
    `select *
     from public.video_analysis_jobs
     where submission_id = $1
     limit 1`,
    [submissionId],
  );
  return row ? mapVideoAnalysisJobRow(row) : null;
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
  const row = await dbQueryMaybeOne(
    `update public.video_analysis_jobs
     set status = 'pending',
         worker_id = null,
         last_error = null,
         started_at = null,
         completed_at = null,
         updated_at = now()
     where submission_id = $1
     returning *`,
    [submissionId],
  );

  if (!row) {
    return null;
  }

  await resetVideoSubmissionAnalysisState(submissionId);
  return mapVideoAnalysisJobRow(row);
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
       j.id as job_id,
       j.status as job_status,
       j.attempts,
       j.last_error,
       j.started_at as job_started_at,
       j.completed_at as job_completed_at,
       s.created_at
     from public.video_submissions s
     left join public.video_analysis_jobs j
       on j.submission_id = s.id
     order by s.id desc
     limit $1`,
    [limit],
  );
}
