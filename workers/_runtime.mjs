import os from "node:os";

function normalizeOptional(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function buildRuntimePayload({ role, entry, workerId, extra = {} }) {
  const invokedAs = normalizeOptional(process.env.WORKER_ENTRY_ALIAS) || entry;
  return {
    role,
    workerId,
    entry,
    invokedAs,
    hostname: os.hostname(),
    pid: process.pid,
    cwd: process.cwd(),
    appEnv: normalizeOptional(process.env.APP_ENV) || normalizeOptional(process.env.NODE_ENV) || "unknown",
    deployTarget: normalizeOptional(process.env.DEPLOY_TARGET) || normalizeOptional(process.env.CLOUD_TARGET),
    workerRelease: normalizeOptional(process.env.WORKER_RELEASE) || normalizeOptional(process.env.GIT_COMMIT),
    ...extra,
  };
}

export function logWorkerRuntimeStarted(params) {
  console.info("worker runtime started", buildRuntimePayload(params));
}

export function logWorkerRuntimeShutdown(params) {
  console.info("worker runtime shutting down", buildRuntimePayload(params));
}

export function announceCompatibilityEntrypoint(aliasEntry, targetEntry) {
  if (!process.env.WORKER_ENTRY_ALIAS) {
    process.env.WORKER_ENTRY_ALIAS = aliasEntry;
  }
  console.warn("worker compatibility entrypoint invoked", {
    aliasEntry,
    targetEntry,
    hostname: os.hostname(),
    pid: process.pid,
    cwd: process.cwd(),
  });
}
