const fs = require("node:fs");
const path = require("node:path");

const MENU_CODE_KEY = "MENU_CODE";
const MENU_UPLOAD_KEY = "MENU_UPLOAD";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function readCliArg(name) {
  const prefix = `${name}=`;
  const matched = process.argv.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : "";
}

function buildMenuUploadUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("from", "menu");
  return url.toString();
}

async function fetchWechatJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }

  return payload;
}

async function getAccessToken(appId, appSecret) {
  const payload = await fetchWechatJson("https://api.weixin.qq.com/cgi-bin/stable_token", {
    method: "POST",
    body: JSON.stringify({
      grant_type: "client_credential",
      appid: appId,
      secret: appSecret,
      force_refresh: false,
    }),
  });
  if (!payload?.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(payload)}`);
  }

  return payload.access_token;
}

async function publishMenu() {
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const isDryRun = process.argv.includes("--dry-run");
  const menuPayload = {
    button: [
      {
        type: "click",
        name: "获取身份码",
        key: MENU_CODE_KEY,
      },
      {
        type: "click",
        name: "上传",
        key: MENU_UPLOAD_KEY,
      },
    ],
  };

  if (isDryRun) {
    console.log(JSON.stringify(menuPayload, null, 2));
    return;
  }

  const appId = requireEnv("WECHAT_APP_ID");
  const appSecret = requireEnv("WECHAT_APP_SECRET");
  const accessToken = await getAccessToken(appId, appSecret);
  const payload = await fetchWechatJson(
    `https://api.weixin.qq.com/cgi-bin/menu/create?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      body: JSON.stringify(menuPayload),
    },
  );

  if ((payload?.errcode ?? 0) !== 0) {
    throw new Error(`Menu publish failed: ${JSON.stringify(payload)}`);
  }

  console.log("Wechat menu published successfully.");
  console.log(JSON.stringify(menuPayload, null, 2));
}

publishMenu().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
