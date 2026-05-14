import { announceCompatibilityEntrypoint } from "./_runtime.mjs";

announceCompatibilityEntrypoint("workers/openai-video-preprocess.mjs", "workers/preprocess-new.mjs");

// Compatibility entrypoint for older deploy scripts and process managers.
// The real worker implementation lives in preprocess-new.mjs.
import "./preprocess-new.mjs";
