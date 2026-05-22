import { NextRequest } from "next/server";

import { logAdminAuditEvent } from "@/lib/admin-audit";
import { disableDomesticUser, requireAdminAppUser, updateDomesticUser } from "@/lib/domestic-admin";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ userId: string }>;
};

function parseUserId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAdminAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { userId } = await context.params;
  const id = parseUserId(userId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_user_id", detail: "账号 ID 不正确。" }, 400);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "invalid_body", detail: "请求体不是有效 JSON。" }, 400);
  }

  const result = await updateDomesticUser({
    userId: id,
    role: String(body.role ?? ""),
    status: String(body.status ?? ""),
    displayName: body.display_name == null ? null : String(body.display_name),
    realName: body.real_name == null ? null : String(body.real_name),
  });

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "user.update",
      targetType: "web_user",
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

  const { userId } = await context.params;
  const id = parseUserId(userId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_user_id", detail: "账号 ID 不正确。" }, 400);
  }

  const result = await disableDomesticUser(id);

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "user.disable",
      targetType: "web_user",
      targetId: id,
    });
  }

  return jsonResponse(result, result.ok ? 200 : 400);
}
