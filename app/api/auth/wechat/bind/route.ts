import { NextRequest } from "next/server";

import {
  attachAppSessionCookie,
  bindWechatIdentityToExistingAccount,
  clearWechatPendingCookie,
  createAppSession,
  mapAuthSetupError,
  parseWechatPendingToken,
  registerCollectorWithWechatIdentity,
  WECHAT_PENDING_COOKIE,
} from "@/lib/app-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || null;
}

export async function POST(request: NextRequest) {
  const identity = parseWechatPendingToken(request.cookies.get(WECHAT_PENDING_COOKIE)?.value);
  if (!identity) {
    return jsonResponse({ ok: false, error: "wechat_pending_expired", detail: "微信授权已过期，请重新授权登录。" }, 401);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "invalid_body", detail: "Invalid JSON body" }, 400);
  }

  try {
    const bindMode = String(body.bind_mode ?? body.mode ?? "collector_signup");
    const result =
      bindMode === "existing_account"
        ? await bindWechatIdentityToExistingAccount({
            identity,
            phone: String(body.phone ?? ""),
            password: String(body.password ?? ""),
            agreementAccepted: body.agreement_accepted === true,
          })
        : await registerCollectorWithWechatIdentity({
            identity,
            teamCode: String(body.team_code ?? body.leader_code ?? ""),
            phone: body.phone == null ? null : String(body.phone),
            password: body.password == null ? null : String(body.password),
            displayName: body.display_name == null ? null : String(body.display_name),
            realName: body.real_name == null ? null : String(body.real_name),
            agreementAccepted: body.agreement_accepted === true,
          });

    if (!result.ok) {
      return jsonResponse(result, 400);
    }

    const session = await createAppSession({
      userId: result.user.id,
      ipAddress: getClientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    const response = jsonResponse(
      {
        ok: true,
        user: result.user,
        redirect_path: result.redirectPath,
      },
      201,
    );

    clearWechatPendingCookie(response);
    return attachAppSessionCookie(response, session.token, session.expiresAt);
  } catch (error) {
    const setupError = mapAuthSetupError(error);
    if (setupError) {
      return jsonResponse(setupError, 500);
    }
    throw error;
  }
}
