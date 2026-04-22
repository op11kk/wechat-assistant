const backendProxyOrigin = process.env.BACKEND_PROXY_ORIGIN?.trim().replace(/\/+$/, "") ?? "";

function filterRequestHeaders(headers: Headers): Headers {
  const forwarded = new Headers(headers);
  forwarded.delete("host");
  forwarded.delete("connection");
  forwarded.delete("content-length");
  forwarded.delete("transfer-encoding");
  forwarded.delete("accept-encoding");
  return forwarded;
}

export function hasBackendProxyOrigin(): boolean {
  return Boolean(backendProxyOrigin);
}

export function buildBackendProxyUrl(pathname: string, search = ""): string {
  if (!backendProxyOrigin) {
    throw new Error("Missing BACKEND_PROXY_ORIGIN");
  }
  return `${backendProxyOrigin}${pathname}${search}`;
}

export async function proxyToBackend(request: Request, pathname: string, search = ""): Promise<Response> {
  const target = buildBackendProxyUrl(pathname, search);
  const headers = filterRequestHeaders(new Headers(request.headers));
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(target, init);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        error: "backend proxy failed",
        detail,
        target,
      },
      { status: 502 },
    );
  }
}
