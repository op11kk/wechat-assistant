import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import WechatBindClient from "@/app/wechat-bind/WechatBindClient";
import { parseWechatPendingToken, WECHAT_PENDING_COOKIE } from "@/lib/app-auth";

type WechatBindPageProps = {
  searchParams?: Promise<{
    team_code?: string;
  }>;
};

export const dynamic = "force-dynamic";

function maskOpenid(openid: string): string {
  if (openid.length <= 8) {
    return openid;
  }
  return `${openid.slice(0, 4)}...${openid.slice(-4)}`;
}

export default async function WechatBindPage({ searchParams }: WechatBindPageProps) {
  const cookieStore = await cookies();
  const identity = parseWechatPendingToken(cookieStore.get(WECHAT_PENDING_COOKIE)?.value);
  if (!identity) {
    redirect("/");
  }

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  return (
    <WechatBindClient
      initialTeamCode={resolvedSearchParams?.team_code ?? ""}
      openidPreview={maskOpenid(identity.openid)}
    />
  );
}
