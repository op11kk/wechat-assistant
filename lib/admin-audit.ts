import type { NextRequest } from "next/server";

import type { AppUserRow } from "@/lib/app-auth";
import { dbQuery, dbQueryMaybeOne } from "@/lib/db";
import { getWebMvpRelation } from "@/lib/env";

const webAdminAuditLogsTable = getWebMvpRelation("web_admin_audit_logs");

export type AdminAuditEvent = {
  id: number;
  actorUserId: number | null;
  actorPhone: string | null;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  requestPath: string | null;
  requestMethod: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type LogAdminAuditParams = {
  request?: NextRequest;
  actor?: AppUserRow | null;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  targetLabel?: string | null;
  payload?: Record<string, unknown>;
};

function parseInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mapAuditEvent(row: {
  id: unknown;
  actor_user_id: unknown;
  actor_phone: unknown;
  actor_role: unknown;
  action: unknown;
  target_type: unknown;
  target_id: unknown;
  target_label: unknown;
  request_path: unknown;
  request_method: unknown;
  ip_address: unknown;
  user_agent: unknown;
  payload: unknown;
  created_at: unknown;
}): AdminAuditEvent {
  return {
    id: parseInteger(row.id),
    actorUserId: row.actor_user_id == null ? null : parseInteger(row.actor_user_id),
    actorPhone: parseNullableText(row.actor_phone),
    actorRole: parseNullableText(row.actor_role),
    action: String(row.action ?? ""),
    targetType: String(row.target_type ?? ""),
    targetId: parseNullableText(row.target_id),
    targetLabel: parseNullableText(row.target_label),
    requestPath: parseNullableText(row.request_path),
    requestMethod: parseNullableText(row.request_method),
    ipAddress: parseNullableText(row.ip_address),
    userAgent: parseNullableText(row.user_agent),
    payload: normalizeJsonObject(row.payload),
    createdAt: String(row.created_at ?? ""),
  };
}

function getClientIp(request: NextRequest | undefined): string | null {
  if (!request) {
    return null;
  }

  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    null
  );
}

function isMissingAuditTableError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "42P01");
}

export async function logAdminAuditEvent(params: LogAdminAuditParams): Promise<void> {
  const requestUrl = params.request ? new URL(params.request.url) : null;

  try {
    await dbQuery(
      `insert into ${webAdminAuditLogsTable} (
         actor_user_id,
         actor_phone,
         actor_role,
         action,
         target_type,
         target_id,
         target_label,
         request_path,
         request_method,
         ip_address,
         user_agent,
         payload
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        params.actor?.id ?? null,
        params.actor?.phone ?? null,
        params.actor?.role ?? "api",
        params.action,
        params.targetType,
        params.targetId == null ? null : String(params.targetId),
        params.targetLabel ?? null,
        requestUrl ? `${requestUrl.pathname}${requestUrl.search}` : null,
        params.request?.method ?? null,
        getClientIp(params.request),
        params.request?.headers.get("user-agent") ?? null,
        params.payload ?? {},
      ],
    );
  } catch (error) {
    if (isMissingAuditTableError(error)) {
    console.warn("admin audit log skipped because web_admin_audit_logs table is missing");
      return;
    }
    console.warn("admin audit log failed", error);
  }
}

export async function listAdminAuditEvents(limit = 100): Promise<AdminAuditEvent[]> {
  const table = await dbQueryMaybeOne<{ exists: string | null }>(
    `select to_regclass('${webAdminAuditLogsTable}') as exists`,
  );
  if (!table?.exists) {
    return [];
  }

  const safeLimit = Math.min(Math.max(limit, 1), 300);
  const rows = await dbQuery<Parameters<typeof mapAuditEvent>[0]>(
    `select *
     from ${webAdminAuditLogsTable}
     order by created_at desc, id desc
     limit $1`,
    [safeLimit],
  );

  return rows.map(mapAuditEvent);
}
