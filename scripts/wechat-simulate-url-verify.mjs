#!/usr/bin/env node
/**
 * 模拟微信公众平台「配置服务器 URL」时的 GET 校验请求（带合法 signature）。
 *
 * 用法：
 *   WECHAT_TOKEN=你的Token node scripts/wechat-simulate-url-verify.mjs
 *   WECHAT_TOKEN=xxx node scripts/wechat-simulate-url-verify.mjs https://你的域名/api/wechat
 *
 * 本地（需已 npm run dev）：
 *   WECHAT_TOKEN=xxx node scripts/wechat-simulate-url-verify.mjs http://127.0.0.1:3000/api/wechat
 */

import { createHash, randomBytes } from "node:crypto";

const token = process.env.WECHAT_TOKEN?.trim();
const baseUrl = process.argv[2]?.trim() || "http://127.0.0.1:3000/api/wechat";

if (!token) {
  console.error("请设置环境变量 WECHAT_TOKEN（须与微信公众平台配置的 Token 一致）");
  process.exit(1);
}

const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(8).toString("hex");
const echostr = `sim_${randomBytes(12).toString("hex")}`;
const signature = createHash("sha1")
  .update([token, timestamp, nonce].sort().join(""), "utf8")
  .digest("hex");

const url = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`);
if (!url.pathname || url.pathname === "/") {
  url.pathname = "/api/wechat";
}
url.searchParams.set("signature", signature);
url.searchParams.set("timestamp", timestamp);
url.searchParams.set("nonce", nonce);
url.searchParams.set("echostr", echostr);

console.log("期望响应正文（应与 echostr 一致）:\n", echostr, "\n");
console.log("完整 URL:\n", url.toString(), "\n");
console.log("curl:\n");
console.log(`curl -sS "${url.toString()}"`);
console.log("");
