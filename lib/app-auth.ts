import { createHmac, randomBytes, scrypt as rawScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { NextRequest, NextResponse } from "next/server";

import { dbQuery, dbQueryMaybeOne, dbQueryOne } from "@/lib/db";
import { env, getWebMvpRelation } from "@/lib/env";
import { createParticipant } from "@/lib/video-submissions";

const scrypt = promisify(rawScrypt);

export const APP_SESSION_COOKIE = "domestic_session";
const APP_SESSION_TTL_DAYS = 30;
const AUTH_CODE_TTL_MINUTES = 5;
const LEGAL_AGREEMENT_VERSION = "placeholder-v1";
const webUsersTable = getWebMvpRelation("web_users");
const webUserIdentitiesTable = getWebMvpRelation("web_user_identities");
const webPhoneVerificationCodesTable = getWebMvpRelation("web_phone_verification_codes");
const webUserSessionsTable = getWebMvpRelation("web_user_sessions");
const webCollectorsTable = getWebMvpRelation("web_collectors");
const webTeamsTable = getWebMvpRelation("web_teams");
const webTeamBindLogsTable = getWebMvpRelation("web_team_bind_logs");

export type AppUserRole = "admin" | "leader" | "collector";
export type AppUserStatus = "pending" | "active" | "disabled";
export const WECHAT_PENDING_COOKIE = "domestic_wechat_pending";
const WECHAT_PENDING_TTL_MINUTES = 15;

export type WechatLoginIdentity = {
  provider: "wechat";
  appid: string;
  openid: string;
  unionid?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  raw?: Record<string, unknown>;
};

export type AppUserRow = {
  id: number;
  phone: string;
  role: AppUserRole;
  status: AppUserStatus;
  display_name: string | null;
  real_name: string | null;
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function getSessionSecret(): string {
  return env.APP_SESSION_SECRET || env.API_SECRET || "dev-domestic-session-secret";
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signValue(value: string): string {
  return createHmac("sha256", getSessionSecret()).update(value, "utf8").digest("base64url");
}

function createSignedJsonToken(payload: Record<string, unknown>): string {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${signValue(encoded)}`;
}

function parseSignedJsonToken(token: string): Record<string, unknown> | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) {
    return null;
  }
  const expected = signValue(encoded);
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(encoded));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected integer but received ${String(value)}`);
  }
  return parsed;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mapAppUserRow(row: {
  id: unknown;
  phone: unknown;
  role: unknown;
  status: unknown;
  display_name: unknown;
  real_name: unknown;
  extra: unknown;
  created_at: unknown;
  updated_at: unknown;
}): AppUserRow {
  return {
    id: parseInteger(row.id),
    phone: String(row.phone),
    role: String(row.role) as AppUserRole,
    status: String(row.status) as AppUserStatus,
    display_name: row.display_name ? String(row.display_name) : null,
    real_name: row.real_name ? String(row.real_name) : null,
    extra: normalizeJsonObject(row.extra),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function getLegalAgreementSnapshot(extra: Record<string, unknown>): {
  accepted: boolean;
  accepted_at?: string;
  version?: string;
  channel?: string;
} | null {
  const raw = extra.legal_agreement;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  return {
    accepted: record.accepted === true,
    accepted_at: typeof record.accepted_at === "string" ? String(record.accepted_at) : undefined,
    version: typeof record.version === "string" ? String(record.version) : undefined,
    channel: typeof record.channel === "string" ? String(record.channel) : undefined,
  };
}

function buildAcceptedLegalAgreementExtra(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    legal_agreement: {
      accepted: true,
      accepted_at: new Date().toISOString(),
      version: LEGAL_AGREEMENT_VERSION,
      channel: "domestic_auth",
    },
  };
}

function normalizeTeamCode(rawCode: string): string {
  return rawCode.replace(/\D/g, "");
}

async function findActiveTeamByCode(teamCode: string): Promise<{ id: number; teamCode: string } | null> {
  const row = await dbQueryMaybeOne<{
    id: unknown;
    team_code: unknown;
  }>(
    `select id, team_code
     from ${webTeamsTable}
     where team_code = $1
       and status = 'active'
     limit 1`,
    [teamCode],
  );

  if (!row) {
    return null;
  }

  return {
    id: parseInteger(row.id),
    teamCode: String(row.team_code ?? teamCode),
  };
}

function normalizeWechatIdentity(identity: WechatLoginIdentity): WechatLoginIdentity {
  return {
    provider: "wechat",
    appid: String(identity.appid || "mock").trim(),
    openid: String(identity.openid || "").trim(),
    unionid: identity.unionid ? String(identity.unionid).trim() : null,
    nickname: identity.nickname ? String(identity.nickname).trim() : null,
    avatarUrl: identity.avatarUrl ? String(identity.avatarUrl).trim() : null,
    raw: normalizeJsonObject(identity.raw),
  };
}

function buildWechatPlaceholderPhone(identity: WechatLoginIdentity): string {
  const digest = createHmac("sha256", getSessionSecret())
    .update(`wechat:${identity.appid}:${identity.openid}`, "utf8")
    .digest("hex");
  const digits = digest
    .split("")
    .map((char) => (/[0-9]/.test(char) ? char : String(char.charCodeAt(0) % 10)))
    .join("")
    .slice(0, 15);
  return `9${digits.padEnd(15, "0")}`;
}

function requiresLegalAgreement(role: AppUserRole): boolean {
  return role === "collector" || role === "leader";
}

function hasAcceptedLegalAgreement(user: AppUserRow): boolean {
  if (!requiresLegalAgreement(user.role)) {
    return true;
  }
  return getLegalAgreementSnapshot(user.extra)?.accepted === true;
}

function validateLegalAgreementInput(params: {
  role: AppUserRole;
  agreementAccepted?: boolean;
}): { ok: true } | { ok: false; error: string; detail: string } {
  if (!requiresLegalAgreement(params.role)) {
    return { ok: true };
  }

  if (params.agreementAccepted === true) {
    return { ok: true };
  }

  return {
    ok: false,
    error: "legal_agreement_required",
    detail: "采集员和团长在登录或注册前，必须勾选并同意法律协议。",
  };
}

async function markLegalAgreementAccepted(user: AppUserRow): Promise<AppUserRow> {
  if (!requiresLegalAgreement(user.role) || hasAcceptedLegalAgreement(user)) {
    return user;
  }

  const row = await dbQueryOne<{
    id: unknown;
    phone: unknown;
    role: unknown;
    status: unknown;
    display_name: unknown;
    real_name: unknown;
    extra: unknown;
    created_at: unknown;
    updated_at: unknown;
  }>(
    `update ${webUsersTable}
     set extra = $1,
         updated_at = now()
     where id = $2
     returning *`,
    [buildAcceptedLegalAgreementExtra(user.extra), user.id],
  );

  return mapAppUserRow(row);
}

export function normalizePhone(rawPhone: string): string {
  return rawPhone.replace(/\D/g, "");
}

export function isValidMainlandPhone(phone: string): boolean {
  return /^1\d{10}$/.test(phone);
}

export function getRoleHomePath(role: AppUserRole): string {
  if (role === "admin") {
    return "/admin";
  }
  if (role === "leader") {
    return "/leader";
  }
  return "/collector";
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded) {
    return false;
  }

  const [scheme, salt, expectedHash] = encoded.split(":");
  if (scheme !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function createSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function hashSessionToken(token: string): string {
  return createHmac("sha256", getSessionSecret()).update(token, "utf8").digest("hex");
}

function hashVerificationCode(phone: string, purpose: string, code: string): string {
  return createHmac("sha256", getSessionSecret()).update(`${phone}:${purpose}:${code}`, "utf8").digest("hex");
}

function shouldExposeDebugCode(): boolean {
  return env.APP_DEBUG_AUTH_CODES === "1" || process.env.NODE_ENV !== "production";
}

export async function findAppUserByPhone(phone: string): Promise<(AppUserRow & { password_hash: string | null }) | null> {
  const row = await dbQueryMaybeOne<{
    id: unknown;
    phone: unknown;
    role: unknown;
    status: unknown;
    display_name: unknown;
    real_name: unknown;
    extra: unknown;
    created_at: unknown;
    updated_at: unknown;
    password_hash: unknown;
  }>(
    `select *
     from ${webUsersTable}
     where phone = $1
     limit 1`,
    [phone],
  );

  if (!row) {
    return null;
  }

  return {
    ...mapAppUserRow(row),
    password_hash: row.password_hash ? String(row.password_hash) : null,
  };
}

export async function findAppUserByWechatIdentity(identity: WechatLoginIdentity): Promise<AppUserRow | null> {
  const normalized = normalizeWechatIdentity(identity);
  if (!normalized.openid) {
    return null;
  }

  const row = await dbQueryMaybeOne<{
    id: unknown;
    phone: unknown;
    role: unknown;
    status: unknown;
    display_name: unknown;
    real_name: unknown;
    extra: unknown;
    created_at: unknown;
    updated_at: unknown;
  }>(
    `select u.*
     from ${webUserIdentitiesTable} i
     join ${webUsersTable} u
       on u.id = i.user_id
     where i.provider = 'wechat'
       and i.appid = $1
       and i.provider_subject = $2
     limit 1`,
    [normalized.appid, normalized.openid],
  );

  return row ? mapAppUserRow(row) : null;
}

async function attachWechatIdentityToUser(user: AppUserRow, identity: WechatLoginIdentity): Promise<void> {
  const normalized = normalizeWechatIdentity(identity);
  if (!normalized.openid) {
    throw new Error("invalid_wechat_identity");
  }

  await dbQuery(
    `insert into ${webUserIdentitiesTable} (
       user_id,
       provider,
       appid,
       provider_subject,
       unionid,
       nickname,
       avatar_url,
       extra
     ) values ($1, 'wechat', $2, $3, $4, $5, $6, $7)`,
    [
      user.id,
      normalized.appid,
      normalized.openid,
      normalized.unionid ?? null,
      normalized.nickname ?? null,
      normalized.avatarUrl ?? null,
      normalized.raw ?? {},
    ],
  );
}

export function createWechatPendingToken(identity: WechatLoginIdentity): string {
  const normalized = normalizeWechatIdentity(identity);
  return createSignedJsonToken({
    identity: normalized,
    expires_at: new Date(Date.now() + WECHAT_PENDING_TTL_MINUTES * 60 * 1000).toISOString(),
  });
}

export function parseWechatPendingToken(token: string | null | undefined): WechatLoginIdentity | null {
  const payload = token ? parseSignedJsonToken(token.trim()) : null;
  if (!payload) {
    return null;
  }

  const expiresAt = new Date(String(payload.expires_at ?? ""));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return null;
  }

  const identity = normalizeJsonObject(payload.identity);
  const openid = String(identity.openid ?? "").trim();
  if (!openid) {
    return null;
  }

  return normalizeWechatIdentity({
    provider: "wechat",
    appid: String(identity.appid ?? "mock"),
    openid,
    unionid: identity.unionid == null ? null : String(identity.unionid),
    nickname: identity.nickname == null ? null : String(identity.nickname),
    avatarUrl: identity.avatarUrl == null ? null : String(identity.avatarUrl),
    raw: normalizeJsonObject(identity.raw),
  });
}

export async function issuePhoneVerificationCode(params: {
  phone: string;
  purpose: "register" | "login";
}): Promise<
  | { ok: true; expiresAt: string; debugCode?: string; role?: AppUserRole; redirectPath?: string }
  | { ok: false; error: string; detail?: string }
> {
  const phone = normalizePhone(params.phone);
  if (!isValidMainlandPhone(phone)) {
    return { ok: false, error: "invalid_phone", detail: "请输入有效的 11 位大陆手机号。" };
  }

  const existing = await findAppUserByPhone(phone);
  if (params.purpose === "register" && existing) {
    return { ok: false, error: "phone_exists", detail: "该手机号已经注册。" };
  }
  if (params.purpose === "login" && !existing) {
    return { ok: false, error: "user_not_found", detail: "该手机号尚未注册。" };
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = hashVerificationCode(phone, params.purpose, code);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MINUTES * 60 * 1000);

  await dbQuery(
    `update ${webPhoneVerificationCodesTable}
     set used_at = now()
     where phone = $1
       and purpose = $2
       and used_at is null`,
    [phone, params.purpose],
  );

  await dbQuery(
    `insert into ${webPhoneVerificationCodesTable} (
       phone,
       purpose,
       code_hash,
       expires_at
     ) values ($1, $2, $3, $4)`,
    [phone, params.purpose, codeHash, expiresAt.toISOString()],
  );

  return {
    ok: true,
    expiresAt: expiresAt.toISOString(),
    ...(params.purpose === "login" && existing
      ? {
          role: existing.role,
          redirectPath: getRoleHomePath(existing.role),
        }
      : {}),
    ...(shouldExposeDebugCode() ? { debugCode: code } : {}),
  };
}

async function verifyPhoneVerificationCode(params: {
  phone: string;
  purpose: "register" | "login";
  code: string;
}): Promise<{ ok: true } | { ok: false; error: string; detail?: string }> {
  const phone = normalizePhone(params.phone);
  const normalizedCode = String(params.code ?? "").trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    return { ok: false, error: "invalid_code", detail: "请输入 6 位验证码。" };
  }

  const row = await dbQueryMaybeOne<{
    id: unknown;
    code_hash: unknown;
    expires_at: unknown;
    used_at: unknown;
  }>(
    `select id, code_hash, expires_at, used_at
     from ${webPhoneVerificationCodesTable}
     where phone = $1
       and purpose = $2
     order by created_at desc
     limit 1`,
    [phone, params.purpose],
  );

  if (!row) {
    return { ok: false, error: "code_not_found", detail: "请先获取验证码。" };
  }

  if (row.used_at) {
    return { ok: false, error: "code_used", detail: "验证码已使用，请重新获取。" };
  }

  const expiresAt = new Date(String(row.expires_at));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "code_expired", detail: "验证码已过期，请重新获取。" };
  }

  const actual = Buffer.from(hashVerificationCode(phone, params.purpose, normalizedCode), "utf8");
  const expected = Buffer.from(String(row.code_hash ?? ""), "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, error: "code_mismatch", detail: "验证码不正确。" };
  }

  await dbQuery(
    `update ${webPhoneVerificationCodesTable}
     set used_at = now()
     where id = $1`,
    [parseInteger(row.id)],
  );

  return { ok: true };
}

export async function registerCollectorAccount(params: {
  phone: string;
  password: string;
  teamCode: string;
  displayName?: string | null;
  realName?: string | null;
  agreementAccepted?: boolean;
}): Promise<
  | { ok: true; user: AppUserRow; redirectPath: string }
  | { ok: false; error: string; detail?: string }
> {
  const phone = normalizePhone(params.phone);
  if (!isValidMainlandPhone(phone)) {
    return { ok: false, error: "invalid_phone", detail: "请输入有效的 11 位大陆手机号。" };
  }

  if (params.password.trim().length < 6) {
    return { ok: false, error: "invalid_password", detail: "密码至少需要 6 位。" };
  }

  const teamCode = normalizeTeamCode(params.teamCode);
  if (!/^\d{6}$/.test(teamCode)) {
    return { ok: false, error: "invalid_team_code", detail: "请输入 6 位团长码。" };
  }

  const team = await findActiveTeamByCode(teamCode);
  if (!team) {
    return { ok: false, error: "team_not_found", detail: "团长码不存在或已停用，请和团长确认后再注册。" };
  }

  const agreementCheck = validateLegalAgreementInput({
    role: "collector",
    agreementAccepted: params.agreementAccepted,
  });
  if (!agreementCheck.ok) {
    return agreementCheck;
  }

  const existing = await findAppUserByPhone(phone);
  if (existing) {
    return { ok: false, error: "phone_exists", detail: "该手机号已经注册。" };
  }

  const passwordHash = await hashPassword(params.password);
  const displayName = params.displayName?.trim() || `采集员${phone.slice(-4)}`;
  const realName = params.realName?.trim() || null;

  const userRow = await dbQueryOne<{
    id: unknown;
    phone: unknown;
    role: unknown;
    status: unknown;
    display_name: unknown;
    real_name: unknown;
    extra: unknown;
    created_at: unknown;
    updated_at: unknown;
  }>(
    `insert into ${webUsersTable} (
       phone,
       password_hash,
       role,
       status,
       display_name,
       real_name,
       extra
     ) values ($1, $2, 'collector', 'active', $3, $4, $5)
     returning *`,
    [phone, passwordHash, displayName, realName, buildAcceptedLegalAgreementExtra({})],
  );

  const user = mapAppUserRow(userRow);
  const participantResult = await createParticipant({
    appUserId: user.id,
    wechatOpenid: `domestic:${phone}`,
    realName: realName ?? displayName,
    phone,
    status: "active",
    extra: {
      signup_source: "domestic_phone_register",
      app_user_role: user.role,
      team_code: team.teamCode,
    },
    consentConfirmed: true,
    testStatus: "not_started",
    formalStatus: "not_started",
  });

  if (participantResult.status !== "created" && participantResult.status !== "exists") {
    await dbQuery(`delete from ${webUsersTable} where id = $1`, [user.id]);
    return {
      ok: false,
      error: "participant_create_failed",
      detail: participantResult.detail ?? "采集员档案创建失败。",
    };
  }

  if (participantResult.participant) {
    await dbQuery(
      `update ${webCollectorsTable}
       set user_id = $1,
           team_id = $2,
           team_bound_at = coalesce(team_bound_at, now()),
           updated_at = now()
       where id = $3`,
      [user.id, team.id, participantResult.participant.id],
    );

    await dbQuery(
      `insert into ${webTeamBindLogsTable} (
         collector_id,
         team_id,
         team_code,
         bind_type,
         source,
         actor_user_id
       ) values ($1, $2, $3, 'bind', 'web', $4)`,
      [participantResult.participant.id, team.id, team.teamCode, user.id],
    );
  }

  return {
    ok: true,
    user,
    redirectPath: getRoleHomePath(user.role),
  };
}

export async function registerCollectorWithWechatIdentity(params: {
  identity: WechatLoginIdentity;
  teamCode: string;
  phone?: string | null;
  password?: string | null;
  displayName?: string | null;
  realName?: string | null;
  agreementAccepted?: boolean;
}): Promise<
  | { ok: true; user: AppUserRow; redirectPath: string }
  | { ok: false; error: string; detail?: string }
> {
  const identity = normalizeWechatIdentity(params.identity);
  if (!identity.openid) {
    return { ok: false, error: "invalid_wechat_identity", detail: "微信身份无效，请重新授权。" };
  }

  const existingIdentityUser = await findAppUserByWechatIdentity(identity);
  if (existingIdentityUser) {
    return {
      ok: true,
      user: existingIdentityUser,
      redirectPath: getRoleHomePath(existingIdentityUser.role),
    };
  }

  const teamCode = normalizeTeamCode(params.teamCode);
  if (!/^\d{6}$/.test(teamCode)) {
    return { ok: false, error: "invalid_team_code", detail: "请输入 6 位团长码。" };
  }

  const team = await findActiveTeamByCode(teamCode);
  if (!team) {
    return { ok: false, error: "team_not_found", detail: "团长码不存在或已停用，请和团长确认后再绑定。" };
  }

  const agreementCheck = validateLegalAgreementInput({
    role: "collector",
    agreementAccepted: params.agreementAccepted,
  });
  if (!agreementCheck.ok) {
    return agreementCheck;
  }

  const normalizedPhone = normalizePhone(params.phone ?? "");
  const phone = normalizedPhone ? normalizedPhone : buildWechatPlaceholderPhone(identity);
  if (normalizedPhone && !isValidMainlandPhone(normalizedPhone)) {
    return { ok: false, error: "invalid_phone", detail: "请输入有效的 11 位大陆手机号，或留空使用微信登录。" };
  }

  const existingPhoneUser = await findAppUserByPhone(phone);
  if (existingPhoneUser) {
    return { ok: false, error: "phone_exists", detail: "该手机号已经注册，请直接登录后由管理员绑定微信。" };
  }

  const password = params.password?.trim() ?? "";
  if (password && password.length < 6) {
    return { ok: false, error: "invalid_password", detail: "备用密码至少需要 6 位，或留空。" };
  }

  const passwordHash = password ? await hashPassword(password) : null;
  const displayName = params.displayName?.trim() || params.realName?.trim() || `微信采集员${identity.openid.slice(-4)}`;
  const realName = params.realName?.trim() || displayName;

  const userRow = await dbQueryOne<{
    id: unknown;
    phone: unknown;
    role: unknown;
    status: unknown;
    display_name: unknown;
    real_name: unknown;
    extra: unknown;
    created_at: unknown;
    updated_at: unknown;
  }>(
    `insert into ${webUsersTable} (
       phone,
       password_hash,
       role,
       status,
       display_name,
       real_name,
       extra
     ) values ($1, $2, 'collector', 'active', $3, $4, $5)
     returning *`,
    [
      phone,
      passwordHash,
      displayName,
      realName,
      buildAcceptedLegalAgreementExtra({
        signup_source: "wechat_oauth",
        phone_is_placeholder: !normalizedPhone,
      }),
    ],
  );

  const user = mapAppUserRow(userRow);

  try {
    await attachWechatIdentityToUser(user, identity);

    const participantResult = await createParticipant({
      appUserId: user.id,
      wechatOpenid: identity.openid,
      realName,
      phone,
      status: "active",
      extra: {
        signup_source: "wechat_oauth",
        app_user_role: user.role,
        team_code: team.teamCode,
        wechat_appid: identity.appid,
        phone_is_placeholder: !normalizedPhone,
      },
      consentConfirmed: true,
      testStatus: "not_started",
      formalStatus: "not_started",
    });

    if (participantResult.status !== "created" && participantResult.status !== "exists") {
      await dbQuery(`delete from ${webUsersTable} where id = $1`, [user.id]);
      return {
        ok: false,
        error: "participant_create_failed",
        detail: participantResult.detail ?? "采集员档案创建失败。",
      };
    }

    if (participantResult.participant) {
      await dbQuery(
        `update ${webCollectorsTable}
         set user_id = $1,
             team_id = $2,
             team_bound_at = coalesce(team_bound_at, now()),
             updated_at = now()
         where id = $3`,
        [user.id, team.id, participantResult.participant.id],
      );

      await dbQuery(
        `insert into ${webTeamBindLogsTable} (
           collector_id,
           team_id,
           team_code,
           bind_type,
           source,
           actor_user_id
         ) values ($1, $2, $3, 'bind', 'web', $4)`,
        [participantResult.participant.id, team.id, team.teamCode, user.id],
      );
    }
  } catch (error) {
    await dbQuery(`delete from ${webUsersTable} where id = $1`, [user.id]);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505") {
      return { ok: false, error: "wechat_already_bound", detail: "该微信已经绑定过账号，请重新登录。" };
    }
    throw error;
  }

  return {
    ok: true,
    user,
    redirectPath: getRoleHomePath(user.role),
  };
}

export async function bindWechatIdentityToExistingAccount(params: {
  identity: WechatLoginIdentity;
  phone: string;
  password: string;
  agreementAccepted?: boolean;
}): Promise<
  | { ok: true; user: AppUserRow; redirectPath: string }
  | { ok: false; error: string; detail?: string }
> {
  const identity = normalizeWechatIdentity(params.identity);
  if (!identity.openid) {
    return { ok: false, error: "invalid_wechat_identity", detail: "微信身份无效，请重新授权。" };
  }

  const existingIdentityUser = await findAppUserByWechatIdentity(identity);
  if (existingIdentityUser) {
    return {
      ok: true,
      user: existingIdentityUser,
      redirectPath: getRoleHomePath(existingIdentityUser.role),
    };
  }

  const authResult = await authenticateByPhonePassword({
    phone: params.phone,
    password: params.password,
    agreementAccepted: params.agreementAccepted,
  });
  if (!authResult.ok) {
    return authResult;
  }

  try {
    await attachWechatIdentityToUser(authResult.user, identity);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505") {
      return { ok: false, error: "wechat_already_bound", detail: "该微信已经绑定过账号，请重新登录。" };
    }
    throw error;
  }

  return authResult;
}

export async function registerCollectorByCode(params: {
  phone: string;
  code: string;
  teamCode: string;
  displayName?: string | null;
  realName?: string | null;
  agreementAccepted?: boolean;
}): Promise<
  | { ok: true; user: AppUserRow; redirectPath: string }
  | { ok: false; error: string; detail?: string }
> {
  const verifyResult = await verifyPhoneVerificationCode({
    phone: params.phone,
    purpose: "register",
    code: params.code,
  });

  if (!verifyResult.ok) {
    return verifyResult;
  }

  const tempPassword = `code-${randomBytes(12).toString("hex")}`;
  return registerCollectorAccount({
    phone: params.phone,
    password: tempPassword,
    teamCode: params.teamCode,
    displayName: params.displayName,
    realName: params.realName,
    agreementAccepted: params.agreementAccepted,
  });
}

export async function authenticateByPhonePassword(params: {
  phone: string;
  password: string;
  agreementAccepted?: boolean;
}): Promise<
  | { ok: true; user: AppUserRow; redirectPath: string }
  | { ok: false; error: string; detail?: string }
> {
  const phone = normalizePhone(params.phone);
  const user = await findAppUserByPhone(phone);
  if (!user) {
    return { ok: false, error: "user_not_found", detail: "账号不存在。" };
  }

  if (user.status !== "active") {
    return { ok: false, error: "user_inactive", detail: "账号当前不可用，请联系管理员。" };
  }

  const agreementCheck = validateLegalAgreementInput({
    role: user.role,
    agreementAccepted: params.agreementAccepted,
  });
  if (!agreementCheck.ok && !hasAcceptedLegalAgreement(user)) {
    return agreementCheck;
  }

  const passwordMatches = await verifyPassword(params.password, user.password_hash);
  if (!passwordMatches) {
    return { ok: false, error: "invalid_password", detail: "手机号或密码不正确。" };
  }

  const nextUser =
    requiresLegalAgreement(user.role) && params.agreementAccepted === true
      ? await markLegalAgreementAccepted(user)
      : user;

  await dbQuery(
    `update ${webUsersTable}
     set last_login_at = now()
     where id = $1`,
    [nextUser.id],
  );

  return {
    ok: true,
    user: nextUser,
    redirectPath: getRoleHomePath(nextUser.role),
  };
}

export async function authenticateByPhoneCode(params: {
  phone: string;
  code: string;
  agreementAccepted?: boolean;
}): Promise<
  | { ok: true; user: AppUserRow; redirectPath: string }
  | { ok: false; error: string; detail?: string }
> {
  const verifyResult = await verifyPhoneVerificationCode({
    phone: params.phone,
    purpose: "login",
    code: params.code,
  });

  if (!verifyResult.ok) {
    return verifyResult;
  }

  const phone = normalizePhone(params.phone);
  const user = await findAppUserByPhone(phone);
  if (!user) {
    return { ok: false, error: "user_not_found", detail: "账号不存在。" };
  }

  if (user.status !== "active") {
    return { ok: false, error: "user_inactive", detail: "账号当前不可用，请联系管理员。" };
  }

  const agreementCheck = validateLegalAgreementInput({
    role: user.role,
    agreementAccepted: params.agreementAccepted,
  });
  if (!agreementCheck.ok && !hasAcceptedLegalAgreement(user)) {
    return agreementCheck;
  }

  const nextUser =
    requiresLegalAgreement(user.role) && params.agreementAccepted === true
      ? await markLegalAgreementAccepted(user)
      : user;

  await dbQuery(
    `update ${webUsersTable}
     set last_login_at = now()
     where id = $1`,
    [nextUser.id],
  );

  return {
    ok: true,
    user: nextUser,
    redirectPath: getRoleHomePath(nextUser.role),
  };
}

export async function createAppSession(params: {
  userId: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + APP_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await dbQuery(
    `insert into ${webUserSessionsTable} (
       user_id,
       session_token_hash,
       expires_at,
       ip_address,
       user_agent
     ) values ($1, $2, $3, $4, $5)`,
    [params.userId, tokenHash, expiresAt.toISOString(), params.ipAddress ?? null, params.userAgent ?? null],
  );

  return { token, expiresAt };
}

export function attachAppSessionCookie(response: NextResponse, token: string, expiresAt: Date): NextResponse {
  response.cookies.set(APP_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return response;
}

export function clearAppSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(APP_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
  return response;
}

export function attachWechatPendingCookie(response: NextResponse, pendingToken: string): NextResponse {
  response.cookies.set(WECHAT_PENDING_COOKIE, pendingToken, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: WECHAT_PENDING_TTL_MINUTES * 60,
  });
  return response;
}

export function clearWechatPendingCookie(response: NextResponse): NextResponse {
  response.cookies.set(WECHAT_PENDING_COOKIE, "", {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
  return response;
}

export async function revokeSessionToken(token: string): Promise<void> {
  await dbQuery(
    `update ${webUserSessionsTable}
     set revoked_at = now()
     where session_token_hash = $1
       and revoked_at is null`,
    [hashSessionToken(token)],
  );
}

export async function revokeAppUserSessions(userId: number): Promise<void> {
  await dbQuery(
    `update ${webUserSessionsTable}
     set revoked_at = now()
     where user_id = $1
       and revoked_at is null`,
    [userId],
  );
}

export async function getCurrentAppUserBySessionToken(token: string | null | undefined): Promise<AppUserRow | null> {
  const normalized = token?.trim();
  if (!normalized) {
    return null;
  }

  const tokenHash = hashSessionToken(normalized);
  const row = await dbQueryMaybeOne<{
    id: unknown;
    phone: unknown;
    role: unknown;
    status: unknown;
    display_name: unknown;
    real_name: unknown;
    extra: unknown;
    created_at: unknown;
    updated_at: unknown;
  }>(
    `select u.*
     from ${webUserSessionsTable} s
     join ${webUsersTable} u
       on u.id = s.user_id
     where s.session_token_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()
       and u.status = 'active'
      limit 1`,
    [tokenHash],
  );

  if (!row) {
    return null;
  }

  await dbQuery(
    `update ${webUserSessionsTable}
     set last_seen_at = now()
     where session_token_hash = $1`,
    [tokenHash],
  );

  return mapAppUserRow(row);
}

export async function getCurrentAppUserFromRequest(request: NextRequest): Promise<AppUserRow | null> {
  return getCurrentAppUserBySessionToken(request.cookies.get(APP_SESSION_COOKIE)?.value?.trim());
}

export function mapAuthSetupError(error: unknown): {
  ok: false;
  error: string;
  detail: string;
  missingRelation?: string;
} | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybePgError = error as {
    code?: string;
    message?: string;
    table?: string;
    column?: string;
  };

  if (maybePgError.code === "42P01") {
    const missingRelation = maybePgError.table || maybePgError.message?.match(/relation "([^"]+)"/)?.[1] || "unknown_table";
    return {
      ok: false,
      error: "auth_schema_missing",
      detail: `当前连接的数据库缺少表 ${missingRelation}，请把 schema_web_mvp.sql 执行到 .env.local 指向的库里。`,
      missingRelation,
    };
  }

  if (maybePgError.code === "42703") {
    const missingColumn = maybePgError.column || maybePgError.message?.match(/column "([^"]+)"/)?.[1] || "unknown_column";
    return {
      ok: false,
      error: "auth_schema_outdated",
      detail: `当前连接的数据库缺少字段 ${missingColumn}，请重新执行最新的 schema_web_mvp.sql。`,
    };
  }

  if (maybePgError.code === "42501") {
    return {
      ok: false,
      error: "auth_schema_permission_denied",
      detail: "当前项目连接使用的数据库账号权限不够。请给 .env.local 里的数据库账号授予 web_mvp schema 和新 Web 表的权限，或改成有权限的数据库账号。",
    };
  }

  return null;
}
