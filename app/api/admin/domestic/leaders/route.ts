import { NextRequest } from "next/server";

import { logAdminAuditEvent } from "@/lib/admin-audit";
import { requireAdminAppUser, upsertDomesticLeader } from "@/lib/domestic-admin";
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

  const result = await upsertDomesticLeader({
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
      action: "leader.upsert",
      targetType: "web_team",
      targetId: String(body.promo_code ?? ""),
      targetLabel: String(body.promoter_name ?? ""),
      payload: {
        phone: String(body.phone ?? ""),
        promoter_name: String(body.promoter_name ?? ""),
        promo_code: String(body.promo_code ?? ""),
        status: String(body.status ?? "active"),
      },
    });
  }

  return jsonResponse(result, result.ok ? 200 : 400);
}
