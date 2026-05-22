-- Bootstrap helpers for domestic MVP admin/leader accounts.
-- Run these statements against the same database used by .env.local.

-- 1) Promote an existing phone account to admin.
-- Replace the phone number before running.
--
-- update public.app_users
-- set role = 'admin',
--     status = 'active',
--     display_name = '系统管理员',
--     real_name = '系统管理员',
--     updated_at = now()
-- where phone = '13800000000';


-- 2) Promote an existing phone account to leader.
-- Replace the phone number and names before running.
--
-- update public.app_users
-- set role = 'leader',
--     status = 'active',
--     display_name = '示例团长',
--     real_name = '示例团长',
--     updated_at = now()
-- where phone = '13900000000';


-- 3) Create or update the leader promo record and bind it back to the leader app user.
-- Replace the phone, promoter name, and 6-digit promo code before running.
--
-- insert into public.team_leader_promoters (
--   promoter_name,
--   promo_code,
--   status,
--   note,
--   app_user_id
-- )
-- select
--   '示例团长',
--   '620001',
--   'active',
--   '国内版 MVP 团长测试账号',
--   u.id
-- from public.app_users u
-- where u.phone = '13900000000'
-- on conflict (promo_code) do update
-- set promoter_name = excluded.promoter_name,
--     status = excluded.status,
--     note = excluded.note,
--     app_user_id = excluded.app_user_id,
--     updated_at = now();


-- 4) Optional check query.
--
-- select
--   u.id as user_id,
--   u.phone,
--   u.role,
--   u.display_name,
--   p.id as leader_id,
--   p.promoter_name,
--   p.promo_code,
--   p.app_user_id
-- from public.app_users u
-- left join public.team_leader_promoters p
--   on p.app_user_id = u.id
-- where u.role in ('admin', 'leader')
-- order by u.id;
