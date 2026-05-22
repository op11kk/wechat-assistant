-- Domestic account system for the China-only MVP.
-- Apply this after schema_video_collector.sql.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.app_users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  display_name TEXT,
  real_name TEXT,
  invited_by_user_id BIGINT REFERENCES public.app_users (id) ON DELETE SET NULL,
  last_login_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_users_role_chk CHECK (role IN ('admin', 'leader', 'collector')),
  CONSTRAINT app_users_status_chk CHECK (status IN ('pending', 'active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_app_users_role_status
  ON public.app_users (role, status);

CREATE TABLE IF NOT EXISTS public.phone_verification_codes (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES public.app_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phone_verification_codes_purpose_chk CHECK (purpose IN ('register', 'login', 'reset_password', 'bind_phone'))
);

CREATE INDEX IF NOT EXISTS idx_phone_verification_codes_lookup
  ON public.phone_verification_codes (phone, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS public.app_user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES public.app_users (id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_user_sessions_user_id
  ON public.app_user_sessions (user_id, expires_at DESC);

ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS app_user_id BIGINT UNIQUE REFERENCES public.app_users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_participants_app_user_id
  ON public.participants (app_user_id);

ALTER TABLE public.team_leader_promoters
  ADD COLUMN IF NOT EXISTS app_user_id BIGINT UNIQUE REFERENCES public.app_users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_team_leader_promoters_app_user_id
  ON public.team_leader_promoters (app_user_id);

CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT,
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

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at
  ON public.admin_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor
  ON public.admin_audit_logs (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target
  ON public.admin_audit_logs (target_type, target_id, created_at DESC);

COMMENT ON TABLE public.app_users IS 'Domestic MVP account table for admin, leader, and collector roles.';
COMMENT ON TABLE public.phone_verification_codes IS 'One-time verification codes for phone registration and login.';
COMMENT ON TABLE public.app_user_sessions IS 'Server-side sessions for the domestic MVP account system.';
COMMENT ON TABLE public.admin_audit_logs IS 'Admin operation audit log for account, team binding, and review actions.';

-- Optional seed example for the first admin account.
-- Replace the phone and password hash before running.
--
-- insert into public.app_users (
--   phone,
--   password_hash,
--   role,
--   status,
--   display_name,
--   real_name
-- ) values (
--   '13800000000',
--   '$2b$10$replace_with_real_hash',
--   'admin',
--   'active',
--   '系统管理员',
--   '系统管理员'
-- );
