import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);
const { Pool } = pg;

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function requireEnv(name) {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

const args = process.argv.slice(2);
const updateDb = args.includes("--update-db");
const listPath = args.find((arg) => !arg.startsWith("--")) || "/tmp/video_keys.txt";
const ffprobeBin = readEnv("FFPROBE_BIN", "ffprobe");
const signedUrlExpiresIn = Number(readEnv("VIDEO_DURATION_SIGNED_URL_EXPIRES_IN", "3600"));

const storageClient = new S3Client({
  region: requireEnv("COS_REGION"),
  endpoint: `https://cos.${requireEnv("COS_REGION")}.myqcloud.com`,
  credentials: {
    accessKeyId: requireEnv("COS_SECRET_ID"),
    secretAccessKey: requireEnv("COS_SECRET_KEY"),
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
});

async function createSignedUrl(objectKey) {
  return getSignedUrl(
    storageClient,
    new GetObjectCommand({
      Bucket: requireEnv("COS_BUCKET"),
      Key: objectKey,
    }),
    { expiresIn: signedUrlExpiresIn },
  );
}

async function probeDurationSeconds(objectKey) {
  const signedUrl = await createSignedUrl(objectKey);
  const { stdout } = await execFileAsync(
    ffprobeBin,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nk=1:nw=1",
      signedUrl,
    ],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid ffprobe duration: ${stdout.trim()}`);
  }
  return duration;
}

async function updateDuration(pool, objectKey, durationSeconds) {
  await pool.query(
    `update public.video_submissions
     set duration_sec = $1
     where object_key = $2`,
    [durationSeconds, objectKey],
  );
}

const content = await readFile(listPath, "utf8");
const keys = content
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

let pool = null;
if (updateDb) {
  pool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    max: 2,
    idleTimeoutMillis: 30_000,
  });
}

console.info("video duration probe started", {
  listPath,
  count: keys.length,
  updateDb,
});

for (const objectKey of keys) {
  try {
    const seconds = await probeDurationSeconds(objectKey);
    const minutes = seconds / 60;
    if (pool) {
      await updateDuration(pool, objectKey, seconds);
    }
    console.log(
      `${objectKey}\t${seconds.toFixed(3)}s\t${minutes.toFixed(2)}min${updateDb ? "\tupdated" : ""}`,
    );
  } catch (error) {
    console.error(
      `${objectKey}\tERROR\t${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (pool) {
  await pool.end();
}
