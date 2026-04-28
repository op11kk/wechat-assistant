-- 团长推广码总览报表
-- 统计每个团长带来多少用户、多少上传、通过多少条视频
SELECT
  tlp.id AS leader_promoter_id,
  tlp.promoter_name,
  tlp.promo_code,
  tlp.status,
  COUNT(DISTINCT p.id) AS participant_count,
  COUNT(vs.id) AS submission_count,
  COUNT(vs.id) FILTER (WHERE vs.review_status = 'approved') AS approved_submission_count,
  COUNT(vs.id) FILTER (WHERE vs.review_status = 'pending') AS pending_submission_count,
  COUNT(vs.id) FILTER (WHERE vs.review_status = 'rejected') AS rejected_submission_count,
  MIN(p.leader_bound_at) AS first_bound_at,
  MAX(p.leader_bound_at) AS last_bound_at,
  MAX(vs.created_at) AS latest_submission_at
FROM public.team_leader_promoters tlp
LEFT JOIN public.participants p
  ON p.leader_promoter_id = tlp.id
LEFT JOIN public.video_submissions vs
  ON vs.participant_id = p.id
GROUP BY tlp.id, tlp.promoter_name, tlp.promo_code, tlp.status
ORDER BY approved_submission_count DESC, submission_count DESC, participant_count DESC, tlp.id DESC;

-- 查看某个团长带来的用户明细
-- 把 300001 改成你要查的团长推广码
SELECT
  tlp.promoter_name,
  tlp.promo_code,
  p.id AS participant_id,
  p.participant_code,
  p.real_name,
  p.phone,
  p.status AS participant_status,
  p.leader_bound_at,
  COUNT(vs.id) AS submission_count,
  COUNT(vs.id) FILTER (WHERE vs.review_status = 'approved') AS approved_submission_count,
  MAX(vs.created_at) AS latest_submission_at
FROM public.team_leader_promoters tlp
JOIN public.participants p
  ON p.leader_promoter_id = tlp.id
LEFT JOIN public.video_submissions vs
  ON vs.participant_id = p.id
WHERE tlp.promo_code = '300001'
GROUP BY
  tlp.promoter_name,
  tlp.promo_code,
  p.id,
  p.participant_code,
  p.real_name,
  p.phone,
  p.status,
  p.leader_bound_at
ORDER BY p.leader_bound_at DESC NULLS LAST, p.id DESC;
