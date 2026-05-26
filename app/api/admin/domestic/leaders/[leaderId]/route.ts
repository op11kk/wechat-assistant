import { NextRequest } from "next/server";

import { logAdminAuditEvent } from "@/lib/admin-audit";
import { disableDomesticLeader, requireAdminAppUser, updateDomesticLeader } from "@/lib/domestic-admin";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ leaderId: string }>;
};

function parseLeaderId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAdminAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { leaderId } = await context.params;
  const id = parseLeaderId(leaderId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_leader_id", detail: "团长 ID 不正确。" }, 400);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "invalid_body", detail: "请求体不是有效 JSON。" }, 400);
  }

  const result = await updateDomesticLeader({
    leaderId: id,
    phone: String(body.phone ?? ""),
    promoterName: String(body.promoter_name ?? ""),
    promoCode: String(body.promo_code ?? ""),
    status: String(body.status ?? "active"),
    note: body.note == null ? null : String(body.note),
    password: body.password == null ? null : String(body.password),
  });

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "leader.update",
      targetType: "web_team",
      targetId: id,
      targetLabel: String(body.promoter_name ?? ""),
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

  const { leaderId } = await context.params;
  const id = parseLeaderId(leaderId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_leader_id", detail: "团长 ID 不正确。" }, 400);
  }

  const result = await disableDomesticLeader(id);

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "leader.disable",
      targetType: "web_team",
      targetId: id,
    });
  }

  return jsonResponse(result, result.ok ? 200 : 400);
}
