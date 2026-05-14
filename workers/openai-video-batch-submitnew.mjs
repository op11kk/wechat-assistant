import { announceCompatibilityEntrypoint } from "./_runtime.mjs";

announceCompatibilityEntrypoint(
  "workers/openai-video-batch-submitnew.mjs",
  "workers/openai-video-batch-submit.mjs",
);

import "./openai-video-batch-submit.mjs";
