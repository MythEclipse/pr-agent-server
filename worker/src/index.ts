/**
 * Worker entry point — placeholder.
 *
 * The run loop (lock → upstream sync → PR gathering → AI fix → merge) is a later
 * task. This file exists so `bun run start` resolves.
 *
 * `bootstrapEnv()` MUST stay the first statement here: PATH and the
 * `PR_AGENT_*` secrets have to be in place before anything reads config
 * (the Python did this at import time, before its config constants).
 */
import { bootstrapEnv } from "./env";

bootstrapEnv();
