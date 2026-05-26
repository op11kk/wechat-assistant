import { Suspense } from "react";
import { cookies } from "next/headers";

import H5UploadClient from "@/app/h5/H5UploadClient";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import { findParticipantByAppUserId } from "@/lib/video-submissions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function H5Page() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);
  const participant = user?.role === "collector" ? await findParticipantByAppUserId(user.id) : null;

  return (
    <Suspense fallback={null}>
      <H5UploadClient initialParticipantCode={participant?.participant_code ?? ""} />
    </Suspense>
  );
}
