import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { findParticipantByCode } from "@/lib/video-submissions";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ participantCode: string }> },
) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { participantCode } = await context.params;
  const code = participantCode.trim();
  if (!code) {
    return jsonResponse({ error: "invalid code" }, 400);
  }
  try {
    const participant = await findParticipantByCode(code);
    if (!participant) {
      return jsonResponse({ error: "not found", hint: code }, 404);
    }
    return jsonResponse({ participant });
  } catch (error) {
    return jsonResponse({ error: "Query failed", detail: String(error) }, 500);
  }
}
