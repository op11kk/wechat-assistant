import { NextRequest } from "next/server";

import { APP_SESSION_COOKIE, clearAppSessionCookie, mapAuthSetupError, revokeSessionToken } from "@/lib/app-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(APP_SESSION_COOKIE)?.value?.trim();
    if (token) {
      await revokeSessionToken(token);
    }

    return clearAppSessionCookie(jsonResponse({ ok: true }));
  } catch (error) {
    const setupError = mapAuthSetupError(error);
    if (setupError) {
      return jsonResponse(setupError, 500);
    }
    throw error;
  }
}
