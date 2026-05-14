import { announceCompatibilityEntrypoint } from "./_runtime.mjs";

announceCompatibilityEntrypoint("workers/submit-new.mjs", "workers/openai-video-batch-submit.mjs");

import "./openai-video-batch-submit.mjs";
