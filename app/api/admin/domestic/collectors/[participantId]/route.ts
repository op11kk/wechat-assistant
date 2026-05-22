import { NextRequest } from "next/server";

import { logAdminAuditEvent } from "@/lib/admin-audit";
import { archiveDomesticCollector, requireAdminAppUser, updateDomesticCollector } from "@/lib/domestic-admin";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ participantId: string }>;
};

function parseParticipantId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAdminAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { participantId } = await context.params;
  const id = parseParticipantId(participantId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_participant_id", detail: "采集员 ID 不正确。" }, 400);
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

  const result = await updateDomesticCollector({
    participantId: id,
    leaderId,
    status: body.status == null ? null : String(body.status),
    realName: body.real_name == null ? null : String(body.real_name),
    phone: body.phone == null ? null : String(body.phone),
    collectorCode: body.collector_code == null ? null : String(body.collector_code),
    actorUserId: auth.user.id,
  });

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "collector.update",
      targetType: "web_collector",
      targetId: id,
      payload: body,
    });
  }

  return jsonResponse(result, result.ok ? 200 : 400);
}

export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAdminAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { participantId } = await context.params;
  const id = parseParticipantId(participantId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_participant_id", detail: "采集员 ID 不正确。" }, 400);
  }

  const result = await archiveDomesticCollector(id);

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "collector.archive",
      targetType: "web_collector",
      targetId: id,
    });
  }

  return jsonResponse(result, result.ok ? 200 : 400);
}
