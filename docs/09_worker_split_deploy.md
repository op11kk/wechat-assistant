# Worker Split Deployment

This project is easiest to operate when Tencent Cloud and GCP have clear responsibilities.

## Recommended split

Tencent Cloud:

- Next.js web / API service
- PostgreSQL
- Tencent COS
- `workers/preprocess-new.mjs`
- optional `workers/wechat-media-worker.mjs`

GCP:

- `workers/openai-video-batch-submit-loop.mjs`
- `workers/openai-video-batch-poll.mjs`

## Why this split works

- Tencent Cloud already owns the upload path, database, and COS.
- GCP only needs outbound access to OpenAI and inbound access to the Tencent PostgreSQL/COS resources.
- The OpenAI workers become easy to identify because they only run in one place.

## Required environment variables

Tencent Cloud must have:

- `DATABASE_URL`
- `COS_SECRET_ID`
- `COS_SECRET_KEY`
- `COS_REGION`
- `COS_BUCKET`
- `APP_ENV=production`
- `DEPLOY_TARGET=tencent`

Optional on Tencent Cloud:

- `WORKER_SECRET`
- `WECHAT_APP_ID`
- `WECHAT_APP_SECRET`
- `PORT=7001`
- `START_WECHAT_MEDIA_WORKER=1`

GCP must have:

- `DATABASE_URL`
- `COS_SECRET_ID`
- `COS_SECRET_KEY`
- `COS_REGION`
- `COS_BUCKET`
- `OPENAI_API_KEY`
- `APP_ENV=production`
- `DEPLOY_TARGET=gcp`

Optional on both:

- `WORKER_RELEASE=<git commit or release tag>`

## Startup commands

Tencent Cloud:

```bash
cd ~/wechat-assistant
npm install
bash scripts/ops/start-workers-tencent.sh
```

GCP:

```bash
cd ~/wechat-assistant
npm install
bash scripts/ops/start-workers-gcp.sh
```

## What to look for in logs

Every canonical worker now emits a `worker runtime started` log with:

- `role`
- `entry`
- `invokedAs`
- `hostname`
- `pid`
- `cwd`
- `appEnv`
- `deployTarget`
- `workerRelease`

Expected roles:

- Tencent Cloud: `openai-video-preprocess`, optionally `wechat-media`
- GCP: `openai-video-batch-submit-loop`, `openai-video-batch-poll`

## Quick status checks

List sessions and worker processes:

```bash
bash scripts/ops/worker-status.sh
```

Attach to a session:

```bash
tmux attach -t preprocess-tencent
tmux attach -t submit-gcp
tmux attach -t poll-gcp
```

Detach from a session:

```text
Ctrl+b d
```

## Do not run in both places

Do not run these workers on both Tencent Cloud and GCP at the same time:

- `workers/preprocess-new.mjs`
- `workers/openai-video-batch-submit-loop.mjs`
- `workers/openai-video-batch-poll.mjs`

Running duplicates is the fastest way to reintroduce confusion.
