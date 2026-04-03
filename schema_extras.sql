-- 与你的表结构对齐：sensor_data.session_id → sessions.session_id（TEXT），sessions.id 为 BIGSERIAL。
-- 在 Supabase SQL Editor 中执行。

-- 建议外键（先确保无孤儿 sensor_data，或先补全 sessions）
/*
ALTER TABLE public.sensor_data
  DROP CONSTRAINT IF EXISTS sensor_data_session_id_fkey;
ALTER TABLE public.sensor_data
  ADD CONSTRAINT sensor_data_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES public.sessions(session_id) ON DELETE CASCADE;
*/

-- 列表：sessions 全列 + 采样聚合（按主键 id 分组）
CREATE OR REPLACE VIEW public.session_stats AS
SELECT
  s.*,
  COUNT(d.id)::bigint AS sample_count,
  MIN(d.timestamp) AS first_timestamp,
  MAX(d.timestamp) AS last_timestamp
FROM public.sessions s
LEFT JOIN public.sensor_data d ON d.session_id = s.session_id
GROUP BY s.id;

GRANT SELECT ON public.session_stats TO anon, authenticated;
