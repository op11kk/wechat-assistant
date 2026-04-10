import { createHash } from "node:crypto";

import { env, hasWechatMediaConfig } from "@/lib/env";

type WechatTokenCache = {
  token: string | null;
  deadline: number;
};

const tokenCache: WechatTokenCache = {
  token: null,
  deadline: 0,
};

function extractXmlTag(xml: string, tagName: string): string | null {
  const cdataPattern = new RegExp(`<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, "i");
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch?.[1]) {
    return cdataMatch[1].trim() || null;
  }
  const textPattern = new RegExp(`<${tagName}>([^<]*)<\\/${tagName}>`, "i");
  const textMatch = xml.match(textPattern);
  return textMatch?.[1]?.trim() || null;
}

export function verifyWechatSignature(signature: string, timestamp: string, nonce: string): boolean {
  const payload = [env.WECHAT_TOKEN, timestamp, nonce].sort().join("");
  const digest = createHash("sha1").update(payload, "utf8").digest("hex");
  return digest === signature;
}

export function parseWechatInboundXml(xml: string): {
  msgType: string;
  openid: string | null;
  toUserName: string | null;
  mediaId: string | null;
  description: string | null;
  event: string | null;
  content: string | null;
} {
  return {
    msgType: (extractXmlTag(xml, "MsgType") ?? "").toLowerCase(),
    openid: extractXmlTag(xml, "FromUserName"),
    toUserName: extractXmlTag(xml, "ToUserName"),
    mediaId: extractXmlTag(xml, "MediaId"),
    description: extractXmlTag(xml, "Description"),
    event: extractXmlTag(xml, "Event"),
    content: extractXmlTag(xml, "Content"),
  };
}

/** 被动回复文本（明文模式），ToUserName/FromUserName 与微信入站报文相反。 */
export function buildWechatPassiveTextReply(params: {
  toUserOpenid: string;
  fromOfficialUserName: string;
  content: string;
}): string {
  const createTime = Math.floor(Date.now() / 1000);
  return `<xml><ToUserName><![CDATA[${params.toUserOpenid}]]></ToUserName><FromUserName><![CDATA[${params.fromOfficialUserName}]]></FromUserName><CreateTime>${createTime}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${params.content}]]></Content></xml>`;
}

export async function getWechatAccessToken(): Promise<string | null> {
  if (!hasWechatMediaConfig()) {
    return null;
  }
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.deadline) {
    return tokenCache.token;
  }
  const query = new URLSearchParams({
    grant_type: "client_credential",
    appid: env.WECHAT_APP_ID,
    secret: env.WECHAT_APP_SECRET,
  });
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/token?${query.toString()}`, {
    cache: "no-store",
  });
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!response.ok || !payload.access_token) {
    console.error("wechat token request failed", payload);
    return null;
  }
  const expires = payload.expires_in ?? 7200;
  tokenCache.token = payload.access_token;
  tokenCache.deadline = now + Math.max(120_000, (expires - 300) * 1000);
  return tokenCache.token;
}

export async function downloadWechatMedia(mediaId: string): Promise<{
  body: Buffer;
  contentType: string;
} | null> {
  const token = await getWechatAccessToken();
  if (!token) {
    return null;
  }
  const query = new URLSearchParams({
    access_token: token,
    media_id: mediaId,
  });
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/media/get?${query.toString()}`, {
    cache: "no-store",
  });
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "video/mp4";
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    console.error("wechat media download failed", response.status, body.toString("utf8").slice(0, 400));
    return null;
  }
  if (contentType.includes("application/json") || body.subarray(0, 1).toString() === "{") {
    console.error("wechat media download returned json", body.toString("utf8").slice(0, 400));
    return null;
  }
  return {
    body,
    contentType,
  };
}
