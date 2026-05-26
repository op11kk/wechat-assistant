-- Standalone table set for the Web three-portal MVP.
-- Apply this on a local PostgreSQL database first. It only creates web_* tables
-- and does not read, alter, or depend on the old WeChat/openid tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS web_mvp;

CREATE TABLE IF NOT EXISTS web_mvp.web_users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  display_name TEXT,
  real_name TEXT,
  invited_by_user_id BIGINT REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  legal_agreed_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_users_role_chk CHECK (role IN ('admin', 'leader', 'collector')),
  CONSTRAINT web_users_status_chk CHECK (status IN ('pending', 'active', 'disabled')),
  CONSTRAINT web_users_phone_chk CHECK (phone ~ '^[0-9]{6,20}$')
);

CREATE INDEX IF NOT EXISTS idx_web_users_role_status
  ON web_mvp.web_users (role, status);

CREATE TABLE IF NOT EXISTS web_mvp.web_user_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES web_mvp.web_users (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  appid TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  unionid TEXT,
  nickname TEXT,
  avatar_url TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_user_identities_provider_chk CHECK (provider IN ('wechat')),
  CONSTRAINT web_user_identities_subject_chk CHECK (provider_subject <> ''),
  CONSTRAINT web_user_identities_provider_subject_key UNIQUE (provider, appid, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_web_user_identities_user_id
  ON web_mvp.web_user_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_web_user_identities_unionid
  ON web_mvp.web_user_identities (provider, unionid)
  WHERE unionid IS NOT NULL;

CREATE TABLE IF NOT EXISTS web_mvp.web_phone_verification_codes (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_phone_verification_codes_purpose_chk CHECK (purpose IN ('register', 'login', 'reset_password', 'bind_phone')),
  CONSTRAINT web_phone_verification_codes_phone_chk CHECK (phone ~ '^[0-9]{6,20}$')
);

CREATE INDEX IF NOT EXISTS idx_web_phone_verification_codes_lookup
  ON web_mvp.web_phone_verification_codes (phone, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS web_mvp.web_user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES web_mvp.web_users (id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_user_sessions_user_id
  ON web_mvp.web_user_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS web_mvp.web_teams (
  id BIGSERIAL PRIMARY KEY,
  team_name TEXT NOT NULL,
  team_code TEXT NOT NULL UNIQUE,
  leader_user_id BIGINT UNIQUE REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_teams_status_chk CHECK (status IN ('active', 'disabled')),
  CONSTRAINT web_teams_code_chk CHECK (team_code ~ '^[0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS idx_web_teams_status
  ON web_mvp.web_teams (status);

CREATE INDEX IF NOT EXISTS idx_web_teams_leader_user_id
  ON web_mvp.web_teams (leader_user_id);

CREATE TABLE IF NOT EXISTS web_mvp.web_collectors (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES web_mvp.web_teams (id) ON DELETE SET NULL,
  collector_code TEXT NOT NULL UNIQUE,
  real_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  team_bound_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_collectors_status_chk CHECK (status IN ('active', 'paused', 'withdrawn')),
  CONSTRAINT web_collectors_code_chk CHECK (collector_code ~ '^[0-9]{6}$'),
  CONSTRAINT web_collectors_phone_chk CHECK (phone ~ '^[0-9]{6,20}$')
);

CREATE INDEX IF NOT EXISTS idx_web_collectors_user_id
  ON web_mvp.web_collectors (user_id);

CREATE INDEX IF NOT EXISTS idx_web_collectors_team_id
  ON web_mvp.web_collectors (team_id);

CREATE INDEX IF NOT EXISTS idx_web_collectors_status
  ON web_mvp.web_collectors (status);

CREATE TABLE IF NOT EXISTS web_mvp.web_team_bind_logs (
  id BIGSERIAL PRIMARY KEY,
  collector_id BIGINT NOT NULL REFERENCES web_mvp.web_collectors (id) ON DELETE CASCADE,
  team_id BIGINT NOT NULL REFERENCES web_mvp.web_teams (id) ON DELETE RESTRICT,
  team_code TEXT NOT NULL,
  bind_type TEXT NOT NULL DEFAULT 'bind',
  source TEXT NOT NULL DEFAULT 'web',
  actor_user_id BIGINT REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_team_bind_logs_type_chk CHECK (bind_type IN ('bind', 'unbind', 'rebind')),
  CONSTRAINT web_team_bind_logs_source_chk CHECK (source IN ('web', 'admin')),
  CONSTRAINT web_team_bind_logs_code_chk CHECK (team_code ~ '^[0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS idx_web_team_bind_logs_collector_id
  ON web_mvp.web_team_bind_logs (collector_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_team_bind_logs_team_id
  ON web_mvp.web_team_bind_logs (team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS web_mvp.web_upload_sessions (
  id TEXT PRIMARY KEY,
  collector_id BIGINT NOT NULL REFERENCES web_mvp.web_collectors (id) ON DELETE RESTRICT,
  user_id BIGINT REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES web_mvp.web_teams (id) ON DELETE SET NULL,
  collector_code TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  storage_provider TEXT NOT NULL DEFAULT 'cos',
  bucket TEXT,
  region TEXT,
  object_key TEXT NOT NULL,
  file_name TEXT,
  size_bytes BIGINT,
  mime TEXT,
  upload_id TEXT NOT NULL,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  uploaded_parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'uploading',
  user_comment TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT web_upload_sessions_source_chk CHECK (source IN ('web', 'h5')),
  CONSTRAINT web_upload_sessions_status_chk CHECK (status IN ('uploading', 'completed', 'aborted', 'expired', 'failed')),
  CONSTRAINT web_upload_sessions_part_size_chk CHECK (part_size > 0),
  CONSTRAINT web_upload_sessions_part_count_chk CHECK (part_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_web_upload_sessions_collector_id
  ON web_mvp.web_upload_sessions (collector_id);

CREATE INDEX IF NOT EXISTS idx_web_upload_sessions_status
  ON web_mvp.web_upload_sessions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS web_mvp.web_video_submissions (
  id BIGSERIAL PRIMARY KEY,
  collector_id BIGINT NOT NULL REFERENCES web_mvp.web_collectors (id) ON DELETE RESTRICT,
  user_id BIGINT REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  team_id BIGINT REFERENCES web_mvp.web_teams (id) ON DELETE SET NULL,
  collector_code TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  storage_provider TEXT NOT NULL DEFAULT 'cos',
  bucket TEXT,
  region TEXT,
  object_key TEXT NOT NULL,
  file_name TEXT,
  size_bytes BIGINT,
  mime TEXT,
  duration_sec NUMERIC,
  user_comment TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  reviewed_by_user_id BIGINT REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  analysis_decision TEXT,
  analysis_ratio NUMERIC,
  analysis_summary TEXT,
  analysis_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  analysis_started_at TIMESTAMPTZ,
  analysis_completed_at TIMESTAMPTZ,
  raw_bucket TEXT,
  raw_key TEXT,
  raw_region TEXT,
  preprocess_version INTEGER NOT NULL DEFAULT 0,
  contact_sheet_manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  contact_sheet_count INTEGER NOT NULL DEFAULT 0,
  openai_batch_id TEXT,
  openai_custom_id TEXT,
  submit_attempt INTEGER NOT NULL DEFAULT 0,
  poll_attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_video_submissions_source_chk CHECK (source IN ('web', 'h5', 'chat', 'admin_import')),
  CONSTRAINT web_video_submissions_review_chk CHECK (review_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT web_video_submissions_analysis_status_chk CHECK (
    analysis_status IN (
      'pending',
      'queued',
      'running',
      'preprocessing',
      'preprocess_ready',
      'submit_pending',
      'submitted',
      'polling',
      'completed',
      'succeeded',
      'failed',
      'failed_terminal',
      'retry_pending'
    )
  ),
  CONSTRAINT web_video_submissions_submit_attempt_chk CHECK (submit_attempt >= 0),
  CONSTRAINT web_video_submissions_poll_attempt_chk CHECK (poll_attempt >= 0)
);

CREATE INDEX IF NOT EXISTS idx_web_video_submissions_collector_id
  ON web_mvp.web_video_submissions (collector_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_video_submissions_team_id
  ON web_mvp.web_video_submissions (team_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_video_submissions_review_status
  ON web_mvp.web_video_submissions (review_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_video_submissions_analysis_status_lease
  ON web_mvp.web_video_submissions (analysis_status, lease_expires_at, id);

ALTER TABLE web_mvp.web_video_submissions
  DROP CONSTRAINT IF EXISTS web_video_submissions_source_chk;

ALTER TABLE web_mvp.web_video_submissions
  ADD CONSTRAINT web_video_submissions_source_chk CHECK (source IN ('web', 'h5', 'chat', 'admin_import'));

ALTER TABLE web_mvp.web_video_submissions
  DROP CONSTRAINT IF EXISTS web_video_submissions_analysis_status_chk;

ALTER TABLE web_mvp.web_video_submissions
  ADD CONSTRAINT web_video_submissions_analysis_status_chk CHECK (
    analysis_status IN (
      'pending',
      'queued',
      'running',
      'preprocessing',
      'preprocess_ready',
      'submit_pending',
      'submitted',
      'polling',
      'completed',
      'succeeded',
      'failed',
      'failed_terminal',
      'retry_pending'
    )
  );

CREATE TABLE IF NOT EXISTS web_mvp.web_video_submission_artifacts (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES web_mvp.web_video_submissions (id) ON DELETE CASCADE,
  preprocess_version INTEGER NOT NULL,
  artifact_type TEXT NOT NULL DEFAULT 'contact_sheet',
  storage_provider TEXT NOT NULL DEFAULT 'cos',
  bucket TEXT,
  region TEXT,
  object_key TEXT NOT NULL,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes BIGINT,
  segment_index INTEGER NOT NULL DEFAULT 0,
  time_points_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_video_submission_artifacts_type_chk CHECK (artifact_type IN ('contact_sheet', 'manifest')),
  CONSTRAINT web_video_submission_artifacts_segment_chk CHECK (segment_index >= 0),
  CONSTRAINT ux_web_video_submission_artifacts_version_segment UNIQUE (submission_id, preprocess_version, artifact_type, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_web_video_submission_artifacts_submission_id
  ON web_mvp.web_video_submission_artifacts (submission_id, preprocess_version, segment_index);

CREATE TABLE IF NOT EXISTS web_mvp.web_video_analysis_jobs (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES web_mvp.web_video_submissions (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  last_error TEXT,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT web_video_analysis_jobs_status_chk CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT web_video_analysis_jobs_attempts_chk CHECK (attempts >= 0),
  CONSTRAINT ux_web_video_analysis_jobs_submission UNIQUE (submission_id)
);

CREATE INDEX IF NOT EXISTS idx_web_video_analysis_jobs_status
  ON web_mvp.web_video_analysis_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS idx_web_video_analysis_jobs_submission_id
  ON web_mvp.web_video_analysis_jobs (submission_id);

CREATE TABLE IF NOT EXISTS web_mvp.web_openai_video_review_batches (
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
  CONSTRAINT web_openai_video_review_batches_status_chk CHECK (
    status IN ('preparing', 'submitted', 'validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelled')
  ),
  CONSTRAINT web_openai_video_review_batches_request_count_chk CHECK (request_count >= 0)
);

CREATE TABLE IF NOT EXISTS web_mvp.web_openai_video_review_batch_items (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES web_mvp.web_openai_video_review_batches (id) ON DELETE CASCADE,
  submission_id BIGINT NOT NULL REFERENCES web_mvp.web_video_submissions (id) ON DELETE CASCADE,
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
  CONSTRAINT web_openai_video_review_batch_items_status_chk CHECK (
    status IN ('queued', 'submitted', 'succeeded', 'failed')
  )
);

ALTER TABLE web_mvp.web_openai_video_review_batch_items
  ADD COLUMN IF NOT EXISTS image_object_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preprocess_version INTEGER,
  ADD COLUMN IF NOT EXISTS sheet_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_web_openai_video_review_batches_status
  ON web_mvp.web_openai_video_review_batches (status, created_at);

CREATE INDEX IF NOT EXISTS idx_web_openai_video_review_batch_items_batch_id
  ON web_mvp.web_openai_video_review_batch_items (batch_id);

CREATE INDEX IF NOT EXISTS idx_web_openai_video_review_batch_items_submission_id
  ON web_mvp.web_openai_video_review_batch_items (submission_id);

CREATE INDEX IF NOT EXISTS idx_web_openai_video_review_batch_items_submission_version
  ON web_mvp.web_openai_video_review_batch_items (submission_id, preprocess_version);

CREATE TABLE IF NOT EXISTS web_mvp.web_admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES web_mvp.web_users (id) ON DELETE SET NULL,
  actor_phone TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  request_path TEXT,
  request_method TEXT,
  ip_address TEXT,
  user_agent TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_admin_audit_logs_created_at
  ON web_mvp.web_admin_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_admin_audit_logs_actor
  ON web_mvp.web_admin_audit_logs (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_admin_audit_logs_target
  ON web_mvp.web_admin_audit_logs (target_type, target_id, created_at DESC);

COMMENT ON TABLE web_mvp.web_users IS 'Web three-portal users for admin, leader, and collector roles.';
COMMENT ON TABLE web_mvp.web_user_identities IS 'External login identities such as WeChat openid, linked to web_users.';
COMMENT ON TABLE web_mvp.web_teams IS 'Web teams owned by leaders. team_code is the Web-side leader invitation code.';
COMMENT ON TABLE web_mvp.web_collectors IS 'Web collectors, independent from old WeChat participants.';
COMMENT ON TABLE web_mvp.web_team_bind_logs IS 'Immutable history for collector-team code bindings.';
COMMENT ON TABLE web_mvp.web_upload_sessions IS 'Multipart upload sessions for Web/H5 uploads before final submission rows are created.';
COMMENT ON TABLE web_mvp.web_video_submissions IS 'Web video submissions and review/AI analysis state.';
COMMENT ON TABLE web_mvp.web_video_submission_artifacts IS 'Preprocess outputs such as contact sheets for Web submissions.';
COMMENT ON TABLE web_mvp.web_video_analysis_jobs IS 'Optional background job queue for Web video analysis.';
COMMENT ON TABLE web_mvp.web_openai_video_review_batches IS 'OpenAI Batch jobs for Web video review.';
COMMENT ON TABLE web_mvp.web_openai_video_review_batch_items IS 'Submission-level OpenAI Batch requests and results for Web submissions.';
COMMENT ON TABLE web_mvp.web_admin_audit_logs IS 'Admin operation audit log for the Web three-portal system.';

-- Optional local seed example for the first admin account.
-- Replace the phone and password_hash before running.
--
-- INSERT INTO web_mvp.web_users (
--   phone,
--   password_hash,
--   role,
--   status,
--   display_name,
--   real_name
-- ) VALUES (
--   '13800000000',
--   '$2b$10$replace_with_real_hash',
--   'admin',
--   'active',
--   '绯荤粺绠＄悊鍛?,
--   '绯荤粺绠＄悊鍛?
-- );
