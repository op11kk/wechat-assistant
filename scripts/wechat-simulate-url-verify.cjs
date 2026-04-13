/**
 * 模拟微信公众平台「配置服务器 URL」时的 GET 校验请求（带 signature/timestamp/nonce/echostr）。
 *
 * 用法：
 *   1) 与本地 .env 一致：在仓库根目录执行
 *      WECHAT_TOKEN=你的Token node scripts/wechat-simulate-url-verify.cjs http://localhost:3000/api/wechat
 *   2) 测线上：
 *      WECHAT_TOKEN=你的Token node scripts/wechat-simulate-url-verify.cjs https://xxx.vercel.app/api/wechat
 *
 * 期望：HTTP 200，响应体与打印的「期望 echostr」一致。若 403，多为 Token 与线上一致性检查。
 */

const { createHash, randomBytes } = require("node:crypto");

function resolveTargetUrl(raw) {
  const fallback = "http://localhost:3000/api/wechat";
  if (!raw) {
    return new URL(fallback);
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withScheme);
}

function main() {
  const token = process.env.WECHAT_TOKEN?.trim();
  const url = resolveTargetUrl(process.argv[2]?.trim());

  if (!token) {
    console.error("错误：请设置环境变量 WECHAT_TOKEN（须与公众平台配置的 Token 一致）。");
    console.error(
      "示例：WECHAT_TOKEN=xxx node scripts/wechat-simulate-url-verify.cjs https://你的域名/api/wechat",
    );
    process.exit(1);
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString("hex");
  const echostr = `sim_${randomBytes(10).toString("hex")}`;

  const signature = createHash("sha1")
    .update([token, timestamp, nonce].sort().join(""), "utf8")
    .digest("hex");

  url.searchParams.set("signature", signature);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("echostr", echostr);

  console.log("--- 微信 URL 校验模拟 ---");
  console.log("请求 URL:", url.toString());
  console.log("期望响应体 (echostr):", echostr);
  console.log("");
  console.log("curl（可复制执行）:");
  console.log(`curl -sS -w "\\nHTTP %{http_code}\\n" "${url.toString()}"`);
  console.log("");
}

main();
