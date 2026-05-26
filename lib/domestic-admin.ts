import type { PoolClient } from "pg";
import { NextRequest } from "next/server";

import {
  type AppUserRow,
  hashPassword,
  isValidMainlandPhone,
  normalizePhone,
  revokeAppUserSessions,
} from "@/lib/app-auth";
import { requireAdminAppUser as requireAdminAppUserCore } from "@/lib/app-permissions";
import { dbQuery, dbQueryMaybeOne, withDbTransaction } from "@/lib/db";
import { getWebMvpRelation } from "@/lib/env";
import { jsonResponse } from "@/lib/http";

const webUsersTable = getWebMvpRelation("web_users");
const webUserIdentitiesTable = getWebMvpRelation("web_user_identities");
const webTeamsTable = getWebMvpRelation("web_teams");
const webCollectorsTable = getWebMvpRelation("web_collectors");
const webTeamBindLogsTable = getWebMvpRelation("web_team_bind_logs");
const webVideoSubmissionsTable = getWebMvpRelation("web_video_submissions");

export type DomesticWechatIdentitySummary = {
  id: number;
  providerSubject: string;
  unionid: string | null;
  nickname: string | null;
  createdAt: string;
};

export type DomesticManagedUser = {
  id: number;
  phone: string;
  role: string;
  status: string;
  displayName: string | null;
  realName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  wechatIdentities: DomesticWechatIdentitySummary[];
};

export type DomesticManagedLeader = {
  leaderId: number;
  promoterName: string;
  promoCode: string;
  status: string;
  appUserId: number | null;
  appUserPhone: string | null;
  note: string | null;
  participantCount: number;
  createdAt: string;
};

export type DomesticManagedCollector = {
  participantId: number;
  participantCode: string;
  realName: string;
  phone: string;
  status: string;
  appUserId: number | null;
  appUserPhone: string | null;
  accountStatus: string | null;
  leaderId: number | null;
  leaderName: string | null;
  leaderPromoCode: string | null;
  submissionCount: number;
  latestSubmittedAt: string | null;
};

export type DomesticManageData = {
  users: DomesticManagedUser[];
  leaders: DomesticManagedLeader[];
  collectors: DomesticManagedCollector[];
};

function parseInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function parseWechatIdentityList(value: unknown): DomesticWechatIdentitySummary[] {
  const rawItems =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;

  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const row = item as Record<string, unknown>;
      const id = parseInteger(row.id);
      const providerSubject = String(row.provider_subject ?? row.providerSubject ?? "");
      if (!id || !providerSubject) {
        return null;
      }
      return {
        id,
        providerSubject,
        unionid: parseNullableText(row.unionid),
        nickname: parseNullableText(row.nickname),
        createdAt: String(row.created_at ?? row.createdAt ?? ""),
      };
    })
    .filter((item): item is DomesticWechatIdentitySummary => Boolean(item));
}

function validateUserStatus(status: string): boolean {
  return ["pending", "active", "disabled"].includes(status);
}

function validateTeamStatus(status: string): boolean {
  return ["active", "disabled"].includes(status);
}

function validateCollectorStatus(status: string): boolean {
  return ["active", "paused", "withdrawn"].includes(status);
}

function validatePhone(phone: string): { ok: true; phone: string } | { ok: false; error: string; detail: string } {
  const normalized = normalizePhone(phone);
  if (!isValidMainlandPhone(normalized)) {
    return { ok: false, error: "invalid_phone", detail: "请输入有效的 11 位大陆手机号。" };
  }
  return { ok: true, phone: normalized };
}

function normalizeOptionalPassword(password?: string | null): string {
  return String(password ?? "").trim();
}

function validateOptionalPassword(password: string): { ok: true } | { ok: false; error: string; detail: string } {
  if (password && password.length < 6) {
    return { ok: false, error: "invalid_password", detail: "密码至少需要 6 位。" };
  }
  return { ok: true };
}

function mapUniqueConflict(error: unknown, detail: string): { ok: false; error: string; detail: string } {
  if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") {
    return { ok: false, error: "unique_conflict", detail };
  }
  throw error;
}

async function nextCollectorCode(client: PoolClient): Promise<string> {
  const row = (
    await client.query<{ max_code: unknown }>(
      `select max(collector_code::int) as max_code
       from ${webCollectorsTable}
       where collector_code ~ '^[0-9]{6}$'`,
    )
  ).rows[0];

  let candidate = Math.max(parseInteger(row?.max_code) + 1, 800001);
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const code = String(candidate).padStart(6, "0");
    const existing = await client.query(
      `select 1 from ${webCollectorsTable} where collector_code = $1 limit 1`,
      [code],
    );
    if (existing.rowCount === 0) {
      return code;
    }
    candidate += 1;
  }

  throw new Error("collector_code_exhausted");
}

async function getLeaderTeamByUserId(
  leaderUserId: number,
  client?: PoolClient,
): Promise<{ id: number; teamCode: string; teamName: string; status: string } | null> {
  const sql = `select id, team_code, team_name, status
     from ${webTeamsTable}
     where leader_user_id = $1
     limit 1`;
  const values = [leaderUserId];
  const row = client
    ? (await client.query<{ id: unknown; team_code: unknown; team_name: unknown; status: unknown }>(sql, values))
        .rows[0]
    : await dbQueryMaybeOne<{ id: unknown; team_code: unknown; team_name: unknown; status: unknown }>(sql, values);

  return row
    ? {
        id: parseInteger(row.id),
        teamCode: String(row.team_code ?? ""),
        teamName: String(row.team_name ?? ""),
        status: String(row.status ?? "active"),
      }
    : null;
}

export async function requireAdminAppUser(request: NextRequest): Promise<
  | { ok: true; user: AppUserRow }
  | { ok: false; response: ReturnType<typeof jsonResponse> }
> {
  return requireAdminAppUserCore(request);
}

export async function getDomesticManageData(): Promise<DomesticManageData> {
  const [users, leaders, collectors] = await Promise.all([
    dbQuery<{
      id: unknown;
      phone: unknown;
      role: unknown;
      status: unknown;
      display_name: unknown;
      real_name: unknown;
      created_at: unknown;
      last_login_at: unknown;
      wechat_identities: unknown;
    }>(
      `select
         u.id,
         u.phone,
         u.role,
         u.status,
         u.display_name,
         u.real_name,
         u.created_at,
         u.last_login_at,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', i.id,
               'provider_subject', i.provider_subject,
               'unionid', i.unionid,
               'nickname', i.nickname,
               'created_at', i.created_at
             )
             order by i.created_at desc
           ) filter (where i.id is not null),
           '[]'::jsonb
         ) as wechat_identities
       from ${webUsersTable} u
       left join ${webUserIdentitiesTable} i
         on i.user_id = u.id
        and i.provider = 'wechat'
       group by u.id, u.phone, u.role, u.status, u.display_name, u.real_name, u.created_at, u.last_login_at
       order by u.id desc
       limit 300`,
    ),
    dbQuery<{
      leader_id: unknown;
      team_name: unknown;
      team_code: unknown;
      status: unknown;
      leader_user_id: unknown;
      app_user_phone: unknown;
      note: unknown;
      participant_count: unknown;
      created_at: unknown;
    }>(
      `select
         l.id as leader_id,
         l.team_name,
         l.team_code,
         l.status,
         l.leader_user_id,
         u.phone as app_user_phone,
         l.note,
         count(c.id) as participant_count,
         l.created_at
       from ${webTeamsTable} l
       left join ${webUsersTable} u
         on u.id = l.leader_user_id
       left join ${webCollectorsTable} c
         on c.team_id = l.id
        and c.status <> 'withdrawn'
       group by l.id, l.team_name, l.team_code, l.status, l.leader_user_id, u.phone, l.note, l.created_at
       order by l.id desc
       limit 300`,
    ),
    dbQuery<{
      participant_id: unknown;
      participant_code: unknown;
      real_name: unknown;
      phone: unknown;
      status: unknown;
      app_user_id: unknown;
      app_user_phone: unknown;
      account_status: unknown;
      leader_id: unknown;
      leader_name: unknown;
      team_code: unknown;
      submission_count: unknown;
      latest_submitted_at: unknown;
    }>(
      `select
         p.id as participant_id,
         p.collector_code as participant_code,
         p.real_name,
         p.phone,
         p.status,
         p.user_id as app_user_id,
         u.phone as app_user_phone,
         u.status as account_status,
         l.id as leader_id,
         l.team_name as leader_name,
         l.team_code as team_code,
         count(s.id) as submission_count,
         max(s.created_at) as latest_submitted_at
       from ${webCollectorsTable} p
       left join ${webUsersTable} u
         on u.id = p.user_id
       left join ${webTeamsTable} l
         on l.id = p.team_id
       left join ${webVideoSubmissionsTable} s
         on s.collector_id = p.id
       group by p.id, p.collector_code, p.real_name, p.phone, p.status, p.user_id, u.phone, u.status, l.id, l.team_name, l.team_code
       order by p.id desc
       limit 500`,
    ),
  ]);

  return {
    users: users.map((row) => ({
      id: parseInteger(row.id),
      phone: String(row.phone ?? ""),
      role: String(row.role ?? ""),
      status: String(row.status ?? ""),
      displayName: parseNullableText(row.display_name),
      realName: parseNullableText(row.real_name),
      createdAt: String(row.created_at ?? ""),
      lastLoginAt: parseNullableText(row.last_login_at),
      wechatIdentities: parseWechatIdentityList(row.wechat_identities),
    })),
    leaders: leaders.map((row) => ({
      leaderId: parseInteger(row.leader_id),
      promoterName: String(row.team_name ?? ""),
      promoCode: String(row.team_code ?? ""),
      status: String(row.status ?? ""),
      appUserId: parseNullableInteger(row.leader_user_id),
      appUserPhone: parseNullableText(row.app_user_phone),
      note: parseNullableText(row.note),
      participantCount: parseInteger(row.participant_count),
      createdAt: String(row.created_at ?? ""),
    })),
    collectors: collectors.map((row) => ({
      participantId: parseInteger(row.participant_id),
      participantCode: String(row.participant_code ?? ""),
      realName: String(row.real_name ?? ""),
      phone: String(row.phone ?? ""),
      status: String(row.status ?? ""),
      appUserId: parseNullableInteger(row.app_user_id),
      appUserPhone: parseNullableText(row.app_user_phone),
      accountStatus: parseNullableText(row.account_status),
      leaderId: parseNullableInteger(row.leader_id),
      leaderName: parseNullableText(row.leader_name),
      leaderPromoCode: parseNullableText(row.team_code),
      submissionCount: parseInteger(row.submission_count),
      latestSubmittedAt: parseNullableText(row.latest_submitted_at),
    })),
  };
}

export async function deleteWechatIdentity(
  identityId: number,
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  if (!Number.isInteger(identityId) || identityId <= 0) {
    return { ok: false, error: "invalid_identity_id", detail: "微信绑定 ID 不正确。" };
  }

  const row = await dbQueryMaybeOne<{ id: unknown }>(
    `delete from ${webUserIdentitiesTable}
     where id = $1
     returning id`,
    [identityId],
  );

  if (!row) {
    return { ok: false, error: "identity_not_found", detail: "微信绑定记录不存在。" };
  }

  return { ok: true };
}

export async function updateDomesticUser(params: {
  userId: number;
  role: string;
  status: string;
  displayName?: string | null;
  realName?: string | null;
  password?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  if (!["admin", "leader", "collector"].includes(params.role)) {
    return { ok: false, error: "invalid_role", detail: "角色只能是 admin、leader 或 collector。" };
  }
  if (!validateUserStatus(params.status)) {
    return { ok: false, error: "invalid_status", detail: "账号状态只能是 pending、active 或 disabled。" };
  }

  const password = normalizeOptionalPassword(params.password);
  const passwordCheck = validateOptionalPassword(password);
  if (!passwordCheck.ok) {
    return passwordCheck;
  }
  const passwordHash = password ? await hashPassword(password) : null;

  const row = await dbQueryMaybeOne<{ id: unknown }>(
    `update ${webUsersTable}
     set role = $1,
         status = $2,
         display_name = nullif($3, ''),
         real_name = nullif($4, ''),
         password_hash = coalesce($5, password_hash),
         updated_at = now()
     where id = $6
     returning id`,
    [params.role, params.status, params.displayName ?? "", params.realName ?? "", passwordHash, params.userId],
  );

  if (!row) {
    return { ok: false, error: "user_not_found", detail: "账号不存在。" };
  }

  if (params.status === "disabled") {
    await revokeAppUserSessions(params.userId);
  }

  return { ok: true };
}

export async function disableDomesticUser(
  userId: number,
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const row = await dbQueryMaybeOne<{ id: unknown }>(
    `update ${webUsersTable}
     set status = 'disabled',
         updated_at = now()
     where id = $1
     returning id`,
    [userId],
  );

  if (!row) {
    return { ok: false, error: "user_not_found", detail: "账号不存在。" };
  }

  await revokeAppUserSessions(userId);
  return { ok: true };
}

export async function upsertDomesticLeader(params: {
  phone: string;
  promoterName: string;
  promoCode: string;
  status: string;
  note?: string | null;
  password?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const phoneResult = validatePhone(params.phone);
  if (!phoneResult.ok) {
    return phoneResult;
  }
  const promoterName = params.promoterName.trim();
  const promoCode = params.promoCode.trim();

  if (!promoterName) {
    return { ok: false, error: "invalid_name", detail: "请输入团长名称。" };
  }
  if (!/^\d{6}$/.test(promoCode)) {
    return { ok: false, error: "invalid_team_code", detail: "邀请码必须是 6 位数字。" };
  }
  if (!validateTeamStatus(params.status)) {
    return { ok: false, error: "invalid_status", detail: "团长状态只能是 active 或 disabled。" };
  }

  const password = normalizeOptionalPassword(params.password);
  const passwordCheck = validateOptionalPassword(password);
  if (!passwordCheck.ok) {
    return passwordCheck;
  }
  const passwordHash = password ? await hashPassword(password) : null;

  try {
    await withDbTransaction(async (client) => {
      const existingUser = (
        await client.query<{ id: unknown; password_hash: unknown }>(
          `select id, password_hash
           from ${webUsersTable}
           where phone = $1
           limit 1`,
          [phoneResult.phone],
        )
      ).rows[0];

      if (!passwordHash && !existingUser?.password_hash) {
        throw new Error("missing_password");
      }

      const user = (
        await client.query<{ id: unknown }>(
          `insert into ${webUsersTable} (
             phone,
             password_hash,
             role,
             status,
             display_name,
             real_name,
             legal_agreed_at
           ) values ($1, $3, 'leader', 'active', $2, $2, now())
           on conflict (phone) do update
           set role = 'leader',
               status = 'active',
               password_hash = coalesce(excluded.password_hash, ${webUsersTable}.password_hash),
               display_name = coalesce(nullif(${webUsersTable}.display_name, ''), excluded.display_name),
               real_name = coalesce(nullif(${webUsersTable}.real_name, ''), excluded.real_name),
               legal_agreed_at = coalesce(${webUsersTable}.legal_agreed_at, excluded.legal_agreed_at),
               updated_at = now()
           returning id`,
          [phoneResult.phone, promoterName, passwordHash],
        )
      ).rows[0];

      await client.query(
        `insert into ${webTeamsTable} (
           team_name,
           team_code,
           status,
           note,
           leader_user_id
         ) values ($1, $2, $3, nullif($4, ''), $5)
         on conflict (team_code) do update
         set team_name = excluded.team_name,
             status = excluded.status,
             note = excluded.note,
             leader_user_id = excluded.leader_user_id,
             updated_at = now()`,
        [promoterName, promoCode, params.status, params.note ?? "", parseInteger(user.id)],
      );
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message === "missing_password") {
      return { ok: false, error: "missing_password", detail: "新建或补齐团长登录账号时，请输入至少 6 位初始密码。" };
    }
    return mapUniqueConflict(error, "手机号或邀请码已经被其他记录使用。");
  }
}

export async function updateDomesticLeader(params: {
  leaderId: number;
  phone: string;
  promoterName: string;
  promoCode: string;
  status: string;
  note?: string | null;
  password?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const phoneResult = validatePhone(params.phone);
  if (!phoneResult.ok) {
    return phoneResult;
  }
  const promoterName = params.promoterName.trim();
  const promoCode = params.promoCode.trim();

  if (!promoterName) {
    return { ok: false, error: "invalid_name", detail: "请输入团长名称。" };
  }
  if (!/^\d{6}$/.test(promoCode)) {
    return { ok: false, error: "invalid_team_code", detail: "邀请码必须是 6 位数字。" };
  }
  if (!validateTeamStatus(params.status)) {
    return { ok: false, error: "invalid_status", detail: "团长状态只能是 active 或 disabled。" };
  }

  const password = normalizeOptionalPassword(params.password);
  const passwordCheck = validateOptionalPassword(password);
  if (!passwordCheck.ok) {
    return passwordCheck;
  }
  const passwordHash = password ? await hashPassword(password) : null;

  try {
    await withDbTransaction(async (client) => {
      const existing = (
        await client.query<{ id: unknown }>(
          `select id from ${webTeamsTable} where id = $1 limit 1`,
          [params.leaderId],
        )
      ).rows[0];
      if (!existing) {
        throw new Error("leader_not_found");
      }

      const existingUser = (
        await client.query<{ id: unknown; password_hash: unknown }>(
          `select id, password_hash
           from ${webUsersTable}
           where phone = $1
           limit 1`,
          [phoneResult.phone],
        )
      ).rows[0];

      if (!passwordHash && !existingUser?.password_hash) {
        throw new Error("missing_password");
      }

      const user = (
        await client.query<{ id: unknown }>(
          `insert into ${webUsersTable} (
             phone,
             password_hash,
             role,
             status,
             display_name,
             real_name,
             legal_agreed_at
           ) values ($1, $3, 'leader', 'active', $2, $2, now())
           on conflict (phone) do update
           set role = 'leader',
               status = 'active',
               password_hash = coalesce(excluded.password_hash, ${webUsersTable}.password_hash),
               display_name = excluded.display_name,
               real_name = excluded.real_name,
               legal_agreed_at = coalesce(${webUsersTable}.legal_agreed_at, excluded.legal_agreed_at),
               updated_at = now()
           returning id`,
          [phoneResult.phone, promoterName, passwordHash],
        )
      ).rows[0];

      await client.query(
        `update ${webTeamsTable}
         set team_name = $1,
             team_code = $2,
             status = $3,
             note = nullif($4, ''),
             leader_user_id = $5,
             updated_at = now()
         where id = $6`,
        [promoterName, promoCode, params.status, params.note ?? "", parseInteger(user.id), params.leaderId],
      );
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message === "leader_not_found") {
      return { ok: false, error: "leader_not_found", detail: "团长不存在。" };
    }
    if (error instanceof Error && error.message === "missing_password") {
      return { ok: false, error: "missing_password", detail: "这个团长登录账号还没有密码，请输入至少 6 位新密码。" };
    }
    return mapUniqueConflict(error, "手机号或邀请码已经被其他记录使用。");
  }
}

export async function disableDomesticLeader(
  leaderId: number,
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const leader = await dbQueryMaybeOne<{ leader_user_id: unknown }>(
    `update ${webTeamsTable}
     set status = 'disabled',
         updated_at = now()
     where id = $1
     returning leader_user_id`,
    [leaderId],
  );

  if (!leader) {
    return { ok: false, error: "leader_not_found", detail: "团长不存在。" };
  }

  const userId = parseNullableInteger(leader.leader_user_id);
  if (userId) {
    await disableDomesticUser(userId);
  }

  return { ok: true };
}

export async function createDomesticCollector(params: {
  phone: string;
  realName: string;
  collectorCode?: string | null;
  leaderId?: number | null;
  status?: string | null;
  actorUserId?: number | null;
  password?: string | null;
}): Promise<{ ok: true; collectorId: number; collectorCode: string } | { ok: false; error: string; detail: string }> {
  const phoneResult = validatePhone(params.phone);
  if (!phoneResult.ok) {
    return phoneResult;
  }

  const realName = params.realName.trim();
  if (!realName) {
    return { ok: false, error: "invalid_name", detail: "请输入采集员姓名。" };
  }

  const requestedCode = params.collectorCode?.trim() ?? "";
  if (requestedCode && !/^\d{6}$/.test(requestedCode)) {
    return { ok: false, error: "invalid_collector_code", detail: "采集员编号必须是 6 位数字，或留空自动生成。" };
  }

  const status = params.status?.trim() || "active";
  if (!validateCollectorStatus(status)) {
    return { ok: false, error: "invalid_status", detail: "采集员状态只能是 active、paused 或 withdrawn。" };
  }

  const password = normalizeOptionalPassword(params.password);
  const passwordCheck = validateOptionalPassword(password);
  if (!passwordCheck.ok) {
    return passwordCheck;
  }
  const passwordHash = password ? await hashPassword(password) : null;

  try {
    return await withDbTransaction(async (client) => {
      let team: { id: number; teamCode: string } | null = null;
      if (params.leaderId !== null && params.leaderId !== undefined) {
        const teamRow = (
          await client.query<{ id: unknown; team_code: unknown }>(
            `select id, team_code from ${webTeamsTable} where id = $1 limit 1`,
            [params.leaderId],
          )
        ).rows[0];
        if (!teamRow) {
          throw new Error("leader_not_found");
        }
        team = { id: parseInteger(teamRow.id), teamCode: String(teamRow.team_code ?? "") };
      }

      const existingUser = (
        await client.query<{ id: unknown; password_hash: unknown }>(
          `select id, password_hash
           from ${webUsersTable}
           where phone = $1
           limit 1`,
          [phoneResult.phone],
        )
      ).rows[0];

      if (!passwordHash && !existingUser?.password_hash) {
        throw new Error("missing_password");
      }

      const user = (
        await client.query<{ id: unknown }>(
          `insert into ${webUsersTable} (
             phone,
             password_hash,
             role,
             status,
             display_name,
             real_name,
             invited_by_user_id,
             legal_agreed_at
           ) values ($1, $4, 'collector', 'active', $2, $2, $3, now())
           on conflict (phone) do update
           set role = 'collector',
               status = 'active',
               password_hash = coalesce(excluded.password_hash, ${webUsersTable}.password_hash),
               display_name = excluded.display_name,
               real_name = excluded.real_name,
               invited_by_user_id = excluded.invited_by_user_id,
               legal_agreed_at = coalesce(${webUsersTable}.legal_agreed_at, excluded.legal_agreed_at),
               updated_at = now()
           returning id`,
          [phoneResult.phone, realName, params.actorUserId ?? null, passwordHash],
        )
      ).rows[0];
      const userId = parseInteger(user.id);

      const collectorCode = requestedCode || (await nextCollectorCode(client));
      const codeOwner = (
        await client.query<{ id: unknown; user_id: unknown }>(
          `select id, user_id from ${webCollectorsTable} where collector_code = $1 limit 1`,
          [collectorCode],
        )
      ).rows[0];
      if (codeOwner && parseNullableInteger(codeOwner.user_id) !== userId) {
        throw new Error("collector_code_exists");
      }

      const existing = (
        await client.query<{ id: unknown }>(
          `select id
           from ${webCollectorsTable}
           where user_id = $1 or phone = $2
           order by id asc
           limit 1`,
          [userId, phoneResult.phone],
        )
      ).rows[0];

      const collector = existing
        ? (
            await client.query<{ id: unknown; collector_code: unknown }>(
              `update ${webCollectorsTable}
               set user_id = $1,
                   team_id = $2,
                   collector_code = $3,
                   real_name = $4,
                   phone = $5,
                   status = $6,
                   team_bound_at = case when $2::bigint is null then null else coalesce(team_bound_at, now()) end,
                   updated_at = now()
               where id = $7
               returning id, collector_code`,
              [userId, team?.id ?? null, collectorCode, realName, phoneResult.phone, status, parseInteger(existing.id)],
            )
          ).rows[0]
        : (
            await client.query<{ id: unknown; collector_code: unknown }>(
              `insert into ${webCollectorsTable} (
                 user_id,
                 team_id,
                 collector_code,
                 real_name,
                 phone,
                 status,
                 team_bound_at
               ) values ($1, $2, $3, $4, $5, $6, case when $2::bigint is null then null else now() end)
               returning id, collector_code`,
              [userId, team?.id ?? null, collectorCode, realName, phoneResult.phone, status],
            )
          ).rows[0];

      if (team) {
        await client.query(
          `insert into ${webTeamBindLogsTable} (
             collector_id,
             team_id,
             team_code,
             bind_type,
             source,
             actor_user_id
           ) values ($1, $2, $3, 'bind', 'admin', $4)`,
          [parseInteger(collector.id), team.id, team.teamCode, params.actorUserId ?? null],
        );
      }

      return {
        ok: true as const,
        collectorId: parseInteger(collector.id),
        collectorCode: String(collector.collector_code ?? collectorCode),
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "leader_not_found") {
      return { ok: false, error: "leader_not_found", detail: "团长不存在。" };
    }
    if (error instanceof Error && error.message === "missing_password") {
      return { ok: false, error: "missing_password", detail: "新建或补齐采集员登录账号时，请输入至少 6 位初始密码。" };
    }
    if (error instanceof Error && error.message === "collector_code_exists") {
      return { ok: false, error: "collector_code_exists", detail: "采集员编号已经被其他人使用。" };
    }
    return mapUniqueConflict(error, "手机号或采集员编号已经被其他记录使用。");
  }
}

export async function updateDomesticCollector(params: {
  participantId: number;
  leaderId: number | null;
  status?: string | null;
  realName?: string | null;
  phone?: string | null;
  collectorCode?: string | null;
  actorUserId?: number | null;
  password?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  if (params.status && !validateCollectorStatus(params.status)) {
    return { ok: false, error: "invalid_status", detail: "采集员状态只能是 active、paused 或 withdrawn。" };
  }

  const phoneResult = params.phone ? validatePhone(params.phone) : null;
  if (phoneResult && !phoneResult.ok) {
    return phoneResult;
  }

  const realName = params.realName?.trim() ?? null;
  if (params.realName !== undefined && !realName) {
    return { ok: false, error: "invalid_name", detail: "请输入采集员姓名。" };
  }

  const collectorCode = params.collectorCode?.trim() ?? null;
  if (collectorCode && !/^\d{6}$/.test(collectorCode)) {
    return { ok: false, error: "invalid_collector_code", detail: "采集员编号必须是 6 位数字。" };
  }

  const password = normalizeOptionalPassword(params.password);
  const passwordCheck = validateOptionalPassword(password);
  if (!passwordCheck.ok) {
    return passwordCheck;
  }
  const passwordHash = password ? await hashPassword(password) : null;

  try {
    await withDbTransaction(async (client) => {
      const current = (
        await client.query<{ id: unknown; user_id: unknown; team_id: unknown }>(
          `select id, user_id, team_id from ${webCollectorsTable} where id = $1 limit 1`,
          [params.participantId],
        )
      ).rows[0];
      if (!current) {
        throw new Error("participant_not_found");
      }

      let leader: { id: number; teamCode: string } | null = null;
      if (params.leaderId !== null) {
        const leaderRow = (
          await client.query<{ id: unknown; team_code: unknown }>(
            `select id, team_code
             from ${webTeamsTable}
             where id = $1
             limit 1`,
            [params.leaderId],
          )
        ).rows[0];
        if (!leaderRow) {
          throw new Error("leader_not_found");
        }
        leader = { id: parseInteger(leaderRow.id), teamCode: String(leaderRow.team_code ?? "") };
      }

      const row = (
        await client.query<{ id: unknown; user_id: unknown }>(
          `update ${webCollectorsTable}
           set team_id = $1,
               team_bound_at = case when $1::bigint is null then null else coalesce(team_bound_at, now()) end,
               status = coalesce($2::text, status),
               real_name = coalesce(nullif($3::text, ''), real_name),
               phone = coalesce($4::text, phone),
               collector_code = coalesce($5::text, collector_code),
               updated_at = now()
           where id = $6
           returning id, user_id`,
          [
            leader?.id ?? null,
            params.status ?? null,
            realName ?? "",
            phoneResult?.ok ? phoneResult.phone : null,
            collectorCode,
            params.participantId,
          ],
        )
      ).rows[0];

      const userId = parseNullableInteger(row.user_id);
      if (userId) {
        await client.query(
          `update ${webUsersTable}
           set display_name = coalesce(nullif($1::text, ''), display_name),
               real_name = coalesce(nullif($1::text, ''), real_name),
               phone = coalesce($2::text, phone),
               status = case when $3::text = 'withdrawn' then 'disabled' else status end,
               password_hash = coalesce($4, password_hash),
               updated_at = now()
           where id = $5`,
          [realName ?? "", phoneResult?.ok ? phoneResult.phone : null, params.status ?? null, passwordHash, userId],
        );
      }

      if (leader && parseNullableInteger(current.team_id) !== leader.id) {
        await client.query(
          `insert into ${webTeamBindLogsTable} (
             collector_id,
             team_id,
             team_code,
             bind_type,
             source,
             actor_user_id
           ) values ($1, $2, $3, 'bind', 'admin', $4)`,
          [params.participantId, leader.id, leader.teamCode, params.actorUserId ?? null],
        );
      }
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message === "participant_not_found") {
      return { ok: false, error: "participant_not_found", detail: "采集员不存在。" };
    }
    if (error instanceof Error && error.message === "leader_not_found") {
      return { ok: false, error: "leader_not_found", detail: "团长不存在。" };
    }
    return mapUniqueConflict(error, "手机号或采集员编号已经被其他记录使用。");
  }
}

export async function updateCollectorLeaderBinding(params: {
  participantId: number;
  leaderId: number | null;
  status?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  return updateDomesticCollector(params);
}

export async function archiveDomesticCollector(
  participantId: number,
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const row = await dbQueryMaybeOne<{ id: unknown; user_id: unknown }>(
    `update ${webCollectorsTable}
     set status = 'withdrawn',
         team_id = null,
         team_bound_at = null,
         updated_at = now()
     where id = $1
     returning id, user_id`,
    [participantId],
  );

  if (!row) {
    return { ok: false, error: "participant_not_found", detail: "采集员不存在。" };
  }

  const userId = parseNullableInteger(row.user_id);
  if (userId) {
    await disableDomesticUser(userId);
  }

  return { ok: true };
}

export async function createLeaderCollector(params: {
  leaderUserId: number;
  phone: string;
  realName: string;
  collectorCode?: string | null;
  password?: string | null;
}): Promise<{ ok: true; collectorId: number; collectorCode: string } | { ok: false; error: string; detail: string }> {
  const team = await getLeaderTeamByUserId(params.leaderUserId);
  if (!team || team.status !== "active") {
    return { ok: false, error: "leader_team_not_found", detail: "当前团长账号还没有可用团队。" };
  }

  return createDomesticCollector({
    phone: params.phone,
    realName: params.realName,
    collectorCode: params.collectorCode,
    leaderId: team.id,
    status: "active",
    actorUserId: params.leaderUserId,
    password: params.password,
  });
}

export async function updateLeaderCollector(params: {
  leaderUserId: number;
  participantId: number;
  realName?: string | null;
  phone?: string | null;
  status?: string | null;
  password?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const team = await getLeaderTeamByUserId(params.leaderUserId);
  if (!team || team.status !== "active") {
    return { ok: false, error: "leader_team_not_found", detail: "当前团长账号还没有可用团队。" };
  }

  const collector = await dbQueryMaybeOne<{ id: unknown }>(
    `select id from ${webCollectorsTable} where id = $1 and team_id = $2 limit 1`,
    [params.participantId, team.id],
  );
  if (!collector) {
    return { ok: false, error: "collector_not_in_team", detail: "这个采集员不属于当前团长团队。" };
  }

  return updateDomesticCollector({
    participantId: params.participantId,
    leaderId: team.id,
    realName: params.realName,
    phone: params.phone,
    status: params.status,
    actorUserId: params.leaderUserId,
    password: params.password,
  });
}

export async function archiveLeaderCollector(params: {
  leaderUserId: number;
  participantId: number;
}): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const team = await getLeaderTeamByUserId(params.leaderUserId);
  if (!team || team.status !== "active") {
    return { ok: false, error: "leader_team_not_found", detail: "当前团长账号还没有可用团队。" };
  }

  const collector = await dbQueryMaybeOne<{ id: unknown }>(
    `select id from ${webCollectorsTable} where id = $1 and team_id = $2 limit 1`,
    [params.participantId, team.id],
  );
  if (!collector) {
    return { ok: false, error: "collector_not_in_team", detail: "这个采集员不属于当前团长团队。" };
  }

  return archiveDomesticCollector(params.participantId);
}
