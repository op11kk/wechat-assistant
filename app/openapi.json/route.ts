import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  try {
    const content = await readFile(path.join(process.cwd(), "openapi.json"), "utf8");
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch {
    return jsonResponse({ error: "OpenAPI file missing" }, 404);
  }
}
