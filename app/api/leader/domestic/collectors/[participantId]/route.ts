import { NextRequest } from "next/server";

import { requireLeaderAppUser } from "@/lib/app-permissions";
import { archiveLeaderCollector, updateLeaderCollector } from "@/lib/domestic-admin";
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
  const auth = await requireLeaderAppUser(request);
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

  const result = await updateLeaderCollector({
    leaderUserId: auth.user.id,
    participantId: id,
    realName: body.real_name == null ? null : String(body.real_name),
    phone: body.phone == null ? null : String(body.phone),
    status: body.status == null ? null : String(body.status),
  });

  return jsonResponse(result, result.ok ? 200 : 400);
}

export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireLeaderAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { participantId } = await context.params;
  const id = parseParticipantId(participantId);
  if (!id) {
    return jsonResponse({ ok: false, error: "invalid_participant_id", detail: "采集员 ID 不正确。" }, 400);
  }

  const result = await archiveLeaderCollector({
    leaderUserId: auth.user.id,
    participantId: id,
  });

  return jsonResponse(result, result.ok ? 200 : 400);
}
