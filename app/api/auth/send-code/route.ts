import { NextRequest } from "next/server";

import { issuePhoneVerificationCode, mapAuthSetupError } from "@/lib/app-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "invalid_body", detail: "Invalid JSON body" }, 400);
  }

  const purpose = String(body.purpose ?? "").trim();
  if (purpose !== "register" && purpose !== "login") {
    return jsonResponse({ ok: false, error: "invalid_purpose", detail: "purpose 必须是 register 或 login。" }, 400);
  }

  try {
    const result = await issuePhoneVerificationCode({
      phone: String(body.phone ?? ""),
      purpose,
    });

    return jsonResponse(result, result.ok ? 200 : 400);
  } catch (error) {
    const setupError = mapAuthSetupError(error);
    if (setupError) {
      return jsonResponse(setupError, 500);
    }
    throw error;
  }
}
