import { NextRequest } from "next/server";

import { logAdminAuditEvent } from "@/lib/admin-audit";
import { deleteWechatIdentity, requireAdminAppUser } from "@/lib/domestic-admin";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ identityId: string }>;
};

function parseIdentityId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAdminAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { identityId } = await context.params;
  const id = parseIdentityId(identityId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_identity_id", detail: "微信绑定 ID 不正确。" }, 400);
  }

  const result = await deleteWechatIdentity(id);

  if (result.ok) {
    await logAdminAuditEvent({
      request,
      actor: auth.user,
      action: "wechat_identity.delete",
      targetType: "web_user_identity",
      targetId: id,
    });
  }

  return jsonResponse(result, result.ok ? 200 : 400);
}
