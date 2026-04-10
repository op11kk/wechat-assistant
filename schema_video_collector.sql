-- 视频数据收集小助手（方案 B）表结构 — 与 docs/04_data_spec.md 对齐。
-- 在 Supabase SQL Editor 中执行。

CREATE TABLE IF NOT EXISTS public.participants (
  id BIGSERIAL PRIMARY KEY,
  wechat_openid TEXT NOT NULL UNIQUE,
  real_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  participant_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT participants_status_chk CHECK (status IN ('active', 'paused', 'withdrawn'))
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

CREATE INDEX IF NOT EXISTS idx_video_submissions_participant_id ON public.video_submissions (participant_id);
CREATE INDEX IF NOT EXISTS idx_video_submissions_review_status ON public.video_submissions (review_status);
CREATE INDEX IF NOT EXISTS idx_video_submissions_created_at ON public.video_submissions (created_at DESC);

-- 对话框上传：同一 media_id 微信可能重试推送，避免重复入库
CREATE UNIQUE INDEX IF NOT EXISTS ux_video_submissions_wechat_media_id
  ON public.video_submissions (wechat_media_id)
  WHERE wechat_media_id IS NOT NULL;

COMMENT ON TABLE public.participants IS '微信服务号用户登记与专属编号';
COMMENT ON TABLE public.video_submissions IS '对话框或 H5 上传后的视频元数据（文件在对象存储）';
