import { spawn } from "node:child_process";

import { logWorkerRuntimeShutdown, logWorkerRuntimeStarted } from "./_runtime.mjs";

const workerId = `${process.env.HOSTNAME || "unknown-host"}:${process.pid}:${Math.random()
  .toString(16)
  .slice(2, 10)}`;
const workerRole = "openai-video-batch-submit-loop";
const workerEntry = "workers/openai-video-batch-submit-loop.mjs";

const intervalMs = Math.max(
  10_000,
  Number(process.env.OPENAI_VIDEO_BATCH_SUBMIT_INTERVAL_MS || 60_000),
);

let shuttingDown = false;
let childProcess = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSubmitOnce() {
  return new Promise((resolve) => {
    childProcess = spawn(process.execPath, ["workers/openai-video-batch-submit.mjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    childProcess.on("error", (error) => {
      console.error("openai video batch submit loop child failed to start", {
        workerId,
        message: error.message,
      });
      childProcess = null;
      resolve(1);
    });

    childProcess.on("exit", (code, signal) => {
      childProcess = null;
      resolve(signal ? 1 : code || 0);
    });
  });
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logWorkerRuntimeShutdown({
    role: workerRole,
    entry: workerEntry,
    workerId,
    extra: { signal },
  });
  console.info("openai video batch submit loop shutting down", { workerId, signal });

  if (childProcess) {
    childProcess.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logWorkerRuntimeStarted({
  role: workerRole,
  entry: workerEntry,
  workerId,
  extra: {
    intervalMs,
  },
});
console.info("openai video batch submit loop started", {
  workerId,
  intervalMs,
});

while (!shuttingDown) {
  console.info("openai video batch submit loop tick", { workerId });

  const exitCode = await runSubmitOnce();
  if (exitCode !== 0 && !shuttingDown) {
    console.warn("openai video batch submit loop child exited non-zero", {
      workerId,
      exitCode,
    });
  }

  if (!shuttingDown) {
    console.info("openai video batch submit loop sleeping", {
      workerId,
      intervalMs,
    });
    await sleep(intervalMs);
  }
}
