import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import {
  enqueueVideoAnalysisJob,
  getVideoAnalysisJobBySubmissionId,
  getVideoAnalysisSubmissionById,
  listRecentVideoAnalysisStates,
  requeueVideoAnalysisJobBySubmissionId,
} from "@/lib/video-analysis";

export const runtime = "nodejs";

const DEFAULT_WAIT_TIMEOUT_SECONDS = 90;
const MAX_WAIT_TIMEOUT_SECONDS = 300;
const WAIT_POLL_INTERVAL_MS = 2000;

function parseSubmissionId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }

  if (typeof value === "number") {
    return value === 1;
  }

  return false;
}

function parseWaitTimeoutSeconds(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WAIT_TIMEOUT_SECONDS;
  }

  return Math.min(parsed, MAX_WAIT_TIMEOUT_SECONDS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getCurrentState(submissionId: number) {
  const [submission, job] = await Promise.all([
    getVideoAnalysisSubmissionById(submissionId),
    getVideoAnalysisJobBySubmissionId(submissionId),
  ]);

  return { submission, job };
}

async function waitForTerminalState(submissionId: number, waitTimeoutSeconds: number) {
  const deadline = Date.now() + waitTimeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const state = await getCurrentState(submissionId);
    const terminal =
      state.job &&
      (state.job.status === "completed" ||
        state.job.status === "failed_terminal" ||
        state.job.status === "succeeded" ||
        state.job.status === "failed");

    if (terminal) {
      return {
        ...state,
        completed: true,
      };
    }

    await sleep(WAIT_POLL_INTERVAL_MS);
  }

  return {
    ...(await getCurrentState(submissionId)),
    completed: false,
  };
}

export async function GET(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const submissionId = parseSubmissionId(request.nextUrl.searchParams.get("submission_id"));
  if (!submissionId) {
    const rows = await listRecentVideoAnalysisStates(50);
    return jsonResponse({ ok: true, items: rows });
  }

  const submission = await getVideoAnalysisSubmissionById(submissionId);
  if (!submission) {
    return jsonResponse({ ok: false, error: "Submission not found" }, 404);
  }

  const job = await getVideoAnalysisJobBySubmissionId(submissionId);
  return jsonResponse({ ok: true, submission, job });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const submissionId = parseSubmissionId(body.submission_id);
  if (!submissionId) {
    return jsonResponse({ ok: false, error: "submission_id is required" }, 400);
  }

  const waitForResult = parseBoolean(body.wait_for_result);
  const waitTimeoutSeconds = parseWaitTimeoutSeconds(body.wait_timeout_seconds);

  const submission = await getVideoAnalysisSubmissionById(submissionId);
  if (!submission) {
    return jsonResponse({ ok: false, error: "Submission not found" }, 404);
  }

  if (!submission.object_key) {
    return jsonResponse(
      {
        ok: false,
        error: "Submission has no object_key yet",
        detail: "Please wait until the video has been uploaded to storage.",
      },
      409,
    );
  }

  const existingJob = await getVideoAnalysisJobBySubmissionId(submissionId);
  let action: "enqueued" | "already_running" | "already_pending" | "requeued";
  let currentJob = existingJob;
  let currentSubmission = submission;

  if (!existingJob) {
    currentJob = await enqueueVideoAnalysisJob({
      submissionId,
      objectKey: submission.object_key,
    });
    action = "enqueued";
  } else if (
    existingJob.status === "preprocessing" ||
    existingJob.status === "submit_pending" ||
    existingJob.status === "submitted" ||
    existingJob.status === "polling" ||
    existingJob.status === "running"
  ) {
    action = "already_running";
  } else if (
    existingJob.status === "queued" ||
    existingJob.status === "preprocess_ready" ||
    existingJob.status === "retry_pending" ||
    existingJob.status === "pending"
  ) {
    action = "already_pending";
  } else {
    currentJob = await requeueVideoAnalysisJobBySubmissionId(submissionId);
    currentSubmission = (await getVideoAnalysisSubmissionById(submissionId)) ?? submission;
    action = "requeued";
  }

  if (!waitForResult) {
    return jsonResponse({
      ok: true,
      action,
      submission: currentSubmission,
      job: currentJob,
    });
  }

  const state = await waitForTerminalState(submissionId, waitTimeoutSeconds);
  return jsonResponse({
    ok: true,
    action,
    wait_for_result: true,
    wait_timeout_seconds: waitTimeoutSeconds,
    completed: state.completed,
    submission: state.submission,
    job: state.job,
  });
}
