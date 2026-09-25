// Entry point: `bun src/main.ts` (and the compiled binary) starts the server.

import { startServer } from "./http/server";

if (import.meta.main) {
  startServer();
}
