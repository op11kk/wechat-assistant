import { NextRequest } from "next/server";

import { requireLeaderAppUser } from "@/lib/app-permissions";
import { createLeaderCollector } from "@/lib/domestic-admin";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireLeaderAppUser(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "invalid_body", detail: "请求体不是有效 JSON。" }, 400);
  }

  const result = await createLeaderCollector({
    leaderUserId: auth.user.id,
    phone: String(body.phone ?? ""),
    realName: String(body.real_name ?? ""),
    collectorCode: body.collector_code == null ? null : String(body.collector_code),
    password: body.password == null ? null : String(body.password),
  });

  return jsonResponse(result, result.ok ? 200 : 400);
}
