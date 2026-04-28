import { NextRequest } from "next/server";

import { hasBackendProxyOrigin, proxyToBackend } from "@/lib/backend-proxy";
import { corsPreflightResponse, jsonResponse, withCorsHeaders } from "@/lib/http";
import { bindParticipantLeaderPromoter } from "@/lib/video-submissions";

export const runtime = "nodejs";

export function OPTIONS(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  return corsPreflightResponse(request.headers.get("origin"), "POST,OPTIONS");
}

export async function POST(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }

  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "POST,OPTIONS");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, { headers: corsHeaders });
  }

  const participantCode = String(body.participant_code ?? "").trim();
  const leaderPromoCode = String(body.leader_promo_code ?? "").trim();

  if (!participantCode || !leaderPromoCode) {
    return jsonResponse(
      {
        error: "Missing fields",
        detail: "participant_code and leader_promo_code required",
      },
      400,
      { headers: corsHeaders },
    );
  }

  if (!/^\d{6}$/.test(leaderPromoCode)) {
    return jsonResponse(
      {
        error: "Invalid leader promo code",
        detail: "团长推广码必须是 6 位数字。",
      },
      400,
      { headers: corsHeaders },
    );
  }

  const result = await bindParticipantLeaderPromoter({
    participantCode,
    leaderPromoCode,
    source: "h5",
  });

  if (result.status === "participant_not_found") {
    return jsonResponse({ error: "Participant not found", detail: result.detail }, 404, { headers: corsHeaders });
  }

  if (result.status === "invalid_code") {
    return jsonResponse({ error: "Invalid leader promo code", detail: result.detail }, 404, { headers: corsHeaders });
  }

  if (result.status === "disabled") {
    return jsonResponse({ error: "Leader promo code disabled", detail: result.detail }, 403, { headers: corsHeaders });
  }

  if (!result.participant) {
    return jsonResponse({ error: "Bind failed", detail: result.detail ?? "unknown error" }, 500, { headers: corsHeaders });
  }

  return jsonResponse(
    {
      status: result.status,
      participant_code: result.participant.participant_code,
      leader_referral: result.promoter
        ? {
            promoter_id: result.promoter.id,
            promoter_name: result.promoter.promoter_name,
            promo_code: result.promoter.promo_code,
            status: result.promoter.status,
          }
        : result.participant.leader_promo_code
          ? {
              promoter_id: result.participant.leader_promoter_id,
              promoter_name: "已绑定团长",
              promo_code: result.participant.leader_promo_code,
              status: "active",
            }
          : null,
      detail: result.detail ?? null,
    },
    200,
    { headers: corsHeaders },
  );
}
