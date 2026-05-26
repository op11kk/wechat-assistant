import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import AuthClient from "@/app/auth/AuthClient";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken, getRoleHomePath } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);

  if (user) {
    redirect(getRoleHomePath(user.role));
  }

  return <AuthClient initialMode="login" lockMode totalLogin />;
}
