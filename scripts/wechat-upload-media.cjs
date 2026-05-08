const fs = require("node:fs");
const path = require("node:path");

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

function resolveExistingFile(rawPath, label) {
  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${resolved}`);
  }
  return resolved;
}

function mimeTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}

async function fetchWechatJson(url, init) {
  const response = await fetch(url, init);
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

async function getStableAccessToken(appId, appSecret) {
  const payload = await fetchWechatJson("https://api.weixin.qq.com/cgi-bin/stable_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
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

async function uploadPermanentMaterial(accessToken, type, filePath, extraFields = {}) {
  const buffer = fs.readFileSync(filePath);
  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeTypeForFile(filePath) });
  formData.append("media", blob, path.basename(filePath));

  for (const [key, value] of Object.entries(extraFields)) {
    formData.append(key, value);
  }

  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(type)}`,
    {
      method: "POST",
      body: formData,
    },
  );

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    throw new Error(`Upload ${type} failed: HTTP ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }

  if (payload?.errcode) {
    throw new Error(`Upload ${type} failed: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const appId = requireEnv("WECHAT_APP_ID");
  const appSecret = requireEnv("WECHAT_APP_SECRET");

  const groupQrImagePathArg = readCliArg("--group-qr-image") || readCliArg("--group-image");
  const qrImagePathArg = readCliArg("--qr-image") || readCliArg("--image");
  const sampleVideoPathArg = readCliArg("--sample-video") || readCliArg("--video");
  const sampleCoverPathArg = readCliArg("--sample-cover") || readCliArg("--cover");
  const sampleTitle = readCliArg("--sample-title") || "样片";
  const sampleDescription = readCliArg("--sample-description") || "点击查看19秒拍摄样片";

  if (!groupQrImagePathArg && !qrImagePathArg && !sampleVideoPathArg && !sampleCoverPathArg) {
    throw new Error(
      [
        "Nothing to upload.",
        "Use at least one of:",
        "  --group-qr-image=C:\\path\\to\\group-qr.jpg",
        "  --qr-image=C:\\path\\to\\qr.jpg",
        "  --sample-video=C:\\path\\to\\sample.mp4",
        "  --sample-cover=C:\\path\\to\\cover.jpg",
      ].join("\n"),
    );
  }

  const accessToken = await getStableAccessToken(appId, appSecret);
  const result = {};

  if (groupQrImagePathArg) {
    const groupQrImagePath = resolveExistingFile(groupQrImagePathArg, "Group QR image");
    console.log(`Uploading group QR image: ${groupQrImagePath}`);
    result.groupQr = await uploadPermanentMaterial(accessToken, "image", groupQrImagePath);
  }

  if (qrImagePathArg) {
    const qrImagePath = resolveExistingFile(qrImagePathArg, "QR image");
    console.log(`Uploading QR image: ${qrImagePath}`);
    result.contactQr = await uploadPermanentMaterial(accessToken, "image", qrImagePath);
  }

  if (sampleCoverPathArg) {
    const sampleCoverPath = resolveExistingFile(sampleCoverPathArg, "Sample cover");
    console.log(`Uploading sample cover: ${sampleCoverPath}`);
    result.sampleCover = await uploadPermanentMaterial(accessToken, "image", sampleCoverPath);
  }

  if (sampleVideoPathArg) {
    const sampleVideoPath = resolveExistingFile(sampleVideoPathArg, "Sample video");
    console.log(`Uploading sample video: ${sampleVideoPath}`);
    result.sampleVideo = await uploadPermanentMaterial(accessToken, "video", sampleVideoPath, {
      description: JSON.stringify({
        title: sampleTitle,
        introduction: sampleDescription,
      }),
    });
  }

  console.log("\nWechat media upload completed.\n");
  console.log(JSON.stringify(result, null, 2));

  const outputLines = [];
  if (result.groupQr?.media_id) {
    outputLines.push(`WECHAT_GROUP_QR_MEDIA_ID=${result.groupQr.media_id}`);
  }
  if (result.contactQr?.media_id) {
    outputLines.push(`WECHAT_CONTACT_QR_MEDIA_ID=${result.contactQr.media_id}`);
  }
  if (result.sampleCover?.media_id) {
    outputLines.push(`WECHAT_SAMPLE_COVER_MEDIA_ID=${result.sampleCover.media_id}`);
  }
  if (result.sampleVideo?.media_id) {
    outputLines.push(`WECHAT_SAMPLE_VIDEO_MEDIA_ID=${result.sampleVideo.media_id}`);
  }

  if (outputLines.length > 0) {
    console.log("\nSuggested env values:");
    for (const line of outputLines) {
      console.log(line);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
