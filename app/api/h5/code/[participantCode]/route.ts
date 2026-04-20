import { jsonResponse } from "@/lib/http";
import {
  decorateSubmissionObjectUrl,
  findParticipantByCode,
  listVideoSubmissionsByParticipantId,
} from "@/lib/video-submissions";

export const runtime = "nodejs";

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

type Params = {
  params: Promise<{
    participantCode: string;
  }>;
};

export async function GET(_request: Request, context: Params) {
  const { participantCode } = await context.params;
  const code = participantCode.trim();

  if (!code) {
    return jsonResponse({ error: "invalid participant code" }, 400);
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
      );
    }

    const submissions = await listVideoSubmissionsByParticipantId(participant.id, 10);
    return jsonResponse({
      participant: {
        id: participant.id,
        participant_code: participant.participant_code,
        status: participant.status,
        display_name: maskName(participant.real_name),
        display_phone: maskPhone(participant.phone),
      },
      submissions: submissions.map((submission) => decorateSubmissionObjectUrl(submission)),
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "lookup failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
