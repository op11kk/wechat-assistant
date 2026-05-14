import { announceCompatibilityEntrypoint } from "./_runtime.mjs";

announceCompatibilityEntrypoint("workers/poll-new.mjs", "workers/openai-video-batch-poll.mjs");

import "./openai-video-batch-poll.mjs";
