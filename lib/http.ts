import { NextResponse } from "next/server";

export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function textResponse(text: string, status = 200): NextResponse {
  return new NextResponse(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export function xmlResponse(xml: string, status = 200): NextResponse {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
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
