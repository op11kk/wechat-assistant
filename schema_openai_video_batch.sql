-- OpenAI Batch video review queue.
-- Apply after schema_video_collector.sql.

CREATE TABLE IF NOT EXISTS public.openai_video_review_batches (
  id BIGSERIAL PRIMARY KEY,
  openai_batch_id TEXT UNIQUE,
  input_file_id TEXT,
  output_file_id TEXT,
  error_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'preparing',
  model TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  last_error TEXT,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT openai_video_review_batches_status_chk CHECK (
    status IN ('preparing', 'submitted', 'validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelled')
  ),
  CONSTRAINT openai_video_review_batches_request_count_chk CHECK (request_count >= 0)
);

CREATE TABLE IF NOT EXISTS public.openai_video_review_batch_items (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES public.openai_video_review_batches (id) ON DELETE CASCADE,
  submission_id BIGINT NOT NULL REFERENCES public.video_submissions (id) ON DELETE CASCADE,
  custom_id TEXT NOT NULL UNIQUE,
  image_object_key TEXT,
  image_object_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  preprocess_version INTEGER,
  sheet_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT openai_video_review_batch_items_status_chk CHECK (
    status IN ('queued', 'submitted', 'succeeded', 'failed')
  )
);

ALTER TABLE public.openai_video_review_batch_items
  ADD COLUMN IF NOT EXISTS image_object_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preprocess_version INTEGER,
  ADD COLUMN IF NOT EXISTS sheet_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_openai_video_review_batches_status
  ON public.openai_video_review_batches (status, created_at);

CREATE INDEX IF NOT EXISTS idx_openai_video_review_batch_items_batch_id
  ON public.openai_video_review_batch_items (batch_id);

CREATE INDEX IF NOT EXISTS idx_openai_video_review_batch_items_submission_id
  ON public.openai_video_review_batch_items (submission_id);

CREATE INDEX IF NOT EXISTS idx_openai_video_review_batch_items_submission_version
  ON public.openai_video_review_batch_items (submission_id, preprocess_version);

COMMENT ON TABLE public.openai_video_review_batches IS 'OpenAI Batch jobs for asynchronous video review.';
COMMENT ON TABLE public.openai_video_review_batch_items IS 'Submission-level OpenAI Batch requests and results.';
