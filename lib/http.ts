import { NextResponse } from "next/server";

import { env } from "@/lib/env";

type ResponseOptions = {
  headers?: HeadersInit;
};

const DEFAULT_H5_CORS_ALLOWED_ORIGINS = [
  "https://app.capego.top",
  "http://127.0.0.1:3002",
  "http://localhost:3002",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
];

function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    new Headers(source).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
}

function getAllowedCorsOrigins(): Set<string> {
  const configured = env.H5_CORS_ALLOWED_ORIGINS
    ? env.H5_CORS_ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_H5_CORS_ALLOWED_ORIGINS;
  return new Set(configured);
}

export function getCorsHeaders(origin: string | null | undefined, methods: string): Headers | null {
  const normalizedOrigin = origin?.trim();
  if (!normalizedOrigin) {
    return null;
  }

  const allowedOrigins = getAllowedCorsOrigins();
  if (!allowedOrigins.has("*") && !allowedOrigins.has(normalizedOrigin)) {
    return null;
  }

  return mergeHeaders({
    "Access-Control-Allow-Origin": allowedOrigins.has("*") ? "*" : normalizedOrigin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
}

export function withCorsHeaders(
  headers: HeadersInit | undefined,
  origin: string | null | undefined,
  methods: string,
): Headers {
  return mergeHeaders(headers, getCorsHeaders(origin, methods) ?? undefined);
}

export function corsPreflightResponse(origin: string | null | undefined, methods: string): NextResponse {
  const headers = getCorsHeaders(origin, methods);
  if (!headers) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers,
  });
}

export function jsonResponse(body: unknown, status = 200, options?: ResponseOptions): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: mergeHeaders(options?.headers),
  });
}

export function textResponse(text: string, status = 200, options?: ResponseOptions): NextResponse {
  return new NextResponse(text, {
    status,
    headers: mergeHeaders(
      {
      "Content-Type": "text/plain; charset=utf-8",
      },
      options?.headers,
    ),
  });
}

export function xmlResponse(xml: string, status = 200, options?: ResponseOptions): NextResponse {
  return new NextResponse(xml, {
    status,
    headers: mergeHeaders(
      {
      "Content-Type": "application/xml; charset=utf-8",
      },
      options?.headers,
    ),
  });
}

export function isDuplicateError(error: { code?: string; message?: string } | null): boolean {
  if (!error) {
    return false;
  }
  if (error.code === "23505") {
    return true;
  }
  const message = (error.message ?? "").toLowerCase();
  return message.includes("duplicate") || message.includes("unique");
}
