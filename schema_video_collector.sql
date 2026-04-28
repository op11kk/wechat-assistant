-- Tencent Cloud + PostgreSQL schema for the WeChat video collector.
-- Apply this on the local PostgreSQL instance first, then reuse it on TencentDB PostgreSQL later.

CREATE TABLE IF NOT EXISTS public.team_leader_promoters (
  id BIGSERIAL PRIMARY KEY,
  promoter_name TEXT NOT NULL,
  promo_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_leader_promoters_status_chk CHECK (status IN ('active', 'disabled')),
  CONSTRAINT team_leader_promoters_code_chk CHECK (promo_code ~ '^[0-9]{6}$')
);

CREATE TABLE IF NOT EXISTS public.participants (
  id BIGSERIAL PRIMARY KEY,
  wechat_openid TEXT NOT NULL UNIQUE,
  real_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  participant_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  leader_promoter_id BIGINT REFERENCES public.team_leader_promoters (id) ON DELETE SET NULL,
  leader_promo_code TEXT,
  leader_bound_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT participants_status_chk CHECK (status IN ('active', 'paused', 'withdrawn')),
  CONSTRAINT participants_leader_promo_code_chk CHECK (leader_promo_code IS NULL OR leader_promo_code ~ '^[0-9]{6}$')
);

CREATE TABLE IF NOT EXISTS public.video_submissions (
  id BIGSERIAL PRIMARY KEY,
  participant_id BIGINT NOT NULL REFERENCES public.participants (id) ON DELETE RESTRICT,
  participant_code TEXT NOT NULL,
  source TEXT NOT NULL,
  wechat_media_id TEXT,
  object_key TEXT NOT NULL,
  file_name TEXT,
  size_bytes BIGINT,
  mime TEXT,
  duration_sec NUMERIC,
  user_comment TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_submissions_source_chk CHECK (source IN ('chat', 'h5')),
  CONSTRAINT video_submissions_review_chk CHECK (review_status IN ('pending', 'approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS public.upload_sessions (
  id TEXT PRIMARY KEY,
  participant_id BIGINT NOT NULL REFERENCES public.participants (id) ON DELETE RESTRICT,
  participant_code TEXT NOT NULL,
  wechat_openid TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'h5',
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
  CONSTRAINT upload_sessions_source_chk CHECK (source IN ('h5')),
  CONSTRAINT upload_sessions_status_chk CHECK (status IN ('uploading', 'completed', 'aborted', 'expired', 'failed')),
  CONSTRAINT upload_sessions_part_size_chk CHECK (part_size > 0),
  CONSTRAINT upload_sessions_part_count_chk CHECK (part_count > 0)
);

CREATE TABLE IF NOT EXISTS public.participant_referral_bind_logs (
  id BIGSERIAL PRIMARY KEY,
  participant_id BIGINT NOT NULL REFERENCES public.participants (id) ON DELETE CASCADE,
  participant_code TEXT NOT NULL,
  leader_promoter_id BIGINT NOT NULL REFERENCES public.team_leader_promoters (id) ON DELETE RESTRICT,
  leader_promo_code TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'h5',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT participant_referral_bind_logs_source_chk CHECK (source IN ('h5')),
  CONSTRAINT participant_referral_bind_logs_code_chk CHECK (leader_promo_code ~ '^[0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS idx_team_leader_promoters_status ON public.team_leader_promoters (status);
CREATE INDEX IF NOT EXISTS idx_participants_leader_promoter_id ON public.participants (leader_promoter_id);
CREATE INDEX IF NOT EXISTS idx_video_submissions_participant_id ON public.video_submissions (participant_id);
CREATE INDEX IF NOT EXISTS idx_video_submissions_review_status ON public.video_submissions (review_status);
CREATE INDEX IF NOT EXISTS idx_video_submissions_created_at ON public.video_submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_participant_id ON public.upload_sessions (participant_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON public.upload_sessions (status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_created_at ON public.upload_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_participant_referral_bind_logs_participant_id ON public.participant_referral_bind_logs (participant_id);
CREATE INDEX IF NOT EXISTS idx_participant_referral_bind_logs_leader_promoter_id ON public.participant_referral_bind_logs (leader_promoter_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_video_submissions_wechat_media_id
  ON public.video_submissions (wechat_media_id)
  WHERE wechat_media_id IS NOT NULL;

COMMENT ON TABLE public.team_leader_promoters IS 'Team leaders and their unique 6-digit promotion codes.';
COMMENT ON TABLE public.participants IS 'Registered WeChat participants and their unique participant codes.';
COMMENT ON TABLE public.video_submissions IS 'Chat and H5 video submissions stored in COS or R2.';
COMMENT ON TABLE public.upload_sessions IS 'Multipart H5 upload sessions before video_submissions rows are finalized.';
COMMENT ON TABLE public.participant_referral_bind_logs IS 'Immutable logs for H5 team leader promo code bindings.';
