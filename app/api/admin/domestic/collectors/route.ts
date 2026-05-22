import { NextRequest } from "next/server";

import { logAdminAuditEvent } from "@/lib/admin-audit";
import { createDomesticCollector, requireAdminAppUser } from "@/lib/domestic-admin";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireAdminAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "invalid_body", detail: "请求体不是有效 JSON。" }, 400);
  }

  const rawLeaderId = body.leader_id;
  const leaderId =
    rawLeaderId === null || rawLeaderId === undefined || rawLeaderId === ""
      ? null
      : Number.parseInt(String(rawLeaderId), 10);
  if (leaderId !== null && !Number.isFinite(leaderId)) {
    return jsonResponse({ ok: false, error: "invalid_leader_id", detail: "团长 ID 不正确。" }, 400);
  }

  const result = await createDomesticCollector({
    phone: String(body.phone ?? ""),
    realName: String(body.real_name ?? ""),
    collectorCode: body.collector_code == null ? null : String(body.collector_code),
    leaderId,
    status: body.status == null ? "active" : String(body.status),
    actorUserId: auth.user.id,
  });

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "collector.create",
      targetType: "web_collector",
      targetId: result.collectorId,
      targetLabel: result.collectorCode,
      payload: body,
    });
  }

  return jsonResponse(result, result.ok ? 200 : 400);
}
