import { corsPreflightResponse, jsonResponse, withCorsHeaders } from "@/lib/http";
import { hasBackendProxyOrigin, proxyToBackend } from "@/lib/backend-proxy";
import {
  deriveWorkflowState,
  H5_SCENES,
  parseSubmissionMeta,
} from "@/lib/h5-workflow";
import {
  decorateSubmissionObjectUrl,
  findParticipantByCode,
  listVideoSubmissionsByParticipantId,
} from "@/lib/video-submissions";

export const runtime = "nodejs";

const DEMO_SCENE_REMAINING: Record<string, string> = {
  厨房: "7/50",
  客厅: "12/50",
  卧室: "9/50",
  卫生间: "5/50",
  通用家务动作: "18/50",
};

const SCENE_DESCRIPTIONS: Record<string, string> = {
  厨房: "餐具取出、清洗、擦拭、晾干、收纳等",
  客厅: "擦桌、扫地、整理杂物、物品收纳等",
  卧室: "整理凌乱物品、归位家具、收纳杂物等",
  卫生间: "台面擦拭、物品归位、地面清洁等",
  通用家务动作: "浇花、衣物整理、小件物品收纳等",
};

function maskName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 1) {
    return trimmed;
  }
  if (trimmed.length === 2) {
    return `${trimmed[0]}*`;
  }
  return `${trimmed[0]}${"*".repeat(Math.max(trimmed.length - 2, 1))}${trimmed[trimmed.length - 1]}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\s+/g, "");
  if (digits.length < 7) {
    return digits;
  }
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function getSubmissionKindLabel(kind: string | null): string {
  if (kind === "test") {
    return "测试视频";
  }
  if (kind === "formal") {
    return "正式任务";
  }
  return "历史上传";
}

type Params = {
  params: Promise<{
    participantCode: string;
  }>;
};

export function OPTIONS(request: Request) {
  if (hasBackendProxyOrigin()) {
    return proxyToBackend(request, request.url ? new URL(request.url).pathname : "/api/h5/code");
  }
  return corsPreflightResponse(request.headers.get("origin"), "GET,OPTIONS");
}

export async function GET(request: Request, context: Params) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "GET,OPTIONS");
  const { participantCode } = await context.params;
  const code = participantCode.trim();

  if (!code) {
    return jsonResponse({ error: "invalid participant code" }, 400, { headers: corsHeaders });
  }

  try {
    const participant = await findParticipantByCode(code);
    if (!participant) {
      return jsonResponse(
        {
          error: "not found",
          detail: "上传码不存在，请回到公众号重新获取。",
        },
        404,
        { headers: corsHeaders },
      );
    }

    const submissions = await listVideoSubmissionsByParticipantId(participant.id, 20);
    const workflow = deriveWorkflowState(participant, submissions);

    return jsonResponse(
      {
        participant: {
          id: participant.id,
          participant_code: participant.participant_code,
          status: participant.status,
          display_name: maskName(participant.real_name),
          display_phone: maskPhone(participant.phone),
        },
        workflow,
        scenes: H5_SCENES.map((scene) => ({
          name: scene,
          remaining_text: DEMO_SCENE_REMAINING[scene] ?? "7/50",
          description: SCENE_DESCRIPTIONS[scene] ?? "",
        })),
        submissions: submissions.map((submission) => {
          const meta = parseSubmissionMeta(submission.user_comment);
          return {
            ...decorateSubmissionObjectUrl(submission),
            submission_kind: submission.submission_type ?? meta.kind,
            submission_kind_label: getSubmissionKindLabel(submission.submission_type ?? meta.kind),
            scene: submission.scene ?? meta.scene,
            note: submission.user_comment ?? meta.note,
          };
        }),
      },
      200,
      { headers: corsHeaders },
    );
  } catch (error) {
    return jsonResponse(
      {
        error: "lookup failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
      { headers: corsHeaders },
    );
  }
}
