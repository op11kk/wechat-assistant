import { NextRequest } from "next/server";

import { getCurrentAppUserFromRequest, mapAuthSetupError } from "@/lib/app-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentAppUserFromRequest(request);
    return jsonResponse({
      ok: true,
      authenticated: Boolean(user),
      user,
    });
  } catch (error) {
    const setupError = mapAuthSetupError(error);
    if (setupError) {
      return jsonResponse(setupError, 500);
    }
    throw error;
  }
}
