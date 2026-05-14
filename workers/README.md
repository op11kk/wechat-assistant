# Worker Entry Guide

Use only these canonical worker entrypoints in deployments and `tmux` sessions:

- `workers/wechat-media-worker.mjs`
- `workers/preprocess-new.mjs`
- `workers/openai-video-batch-submit-loop.mjs`
- `workers/openai-video-batch-poll.mjs`

Legacy or compatibility entrypoints exist only to keep older commands alive:

- `workers/openai-video-preprocess.mjs` -> `workers/preprocess-new.mjs`
- `workers/submit-new.mjs` -> `workers/openai-video-batch-submit.mjs`
- `workers/poll-new.mjs` -> `workers/openai-video-batch-poll.mjs`
- `workers/openai-video-batch-submitnew.mjs` -> `workers/openai-video-batch-submit.mjs`
- `workers/openai-video-batch-submit - new.mjs` -> `workers/openai-video-batch-submit.mjs`

Recommended process naming:

- `wechat-media-tencent`
- `preprocess-tencent`
- `submit-gcp`
- `poll-gcp`

Each canonical worker now logs:

- `role`
- `entry`
- `invokedAs`
- `hostname`
- `pid`
- `cwd`
- `appEnv`
- `deployTarget`
- `workerRelease`
