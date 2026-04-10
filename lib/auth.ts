import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { env } from "@/lib/env";
import { jsonResponse } from "@/lib/http";

function extractApiToken(headers: Headers): string | null {
  const auth = headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token || null;
  }
  const apiKey = headers.get("x-api-key")?.trim() ?? "";
  return apiKey || null;
}

function tokenMatchesSecret(token: string): boolean {
  try {
    const actual = Buffer.from(token, "utf8");
    const expected = Buffer.from(env.API_SECRET, "utf8");
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function requireApiAuth(request: NextRequest): NextResponse | null {
  if (!env.API_SECRET) {
    return null;
  }
  const token = extractApiToken(request.headers);
  if (token && tokenMatchesSecret(token)) {
    return null;
  }
  return jsonResponse(
    {
      error: "Unauthorized",
      detail: "Please provide Authorization: Bearer <API_SECRET> or X-API-Key: <API_SECRET>.",
    },
    401,
  );
}
