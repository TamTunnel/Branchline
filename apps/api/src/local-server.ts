import { serve } from "@hono/node-server";
import type { Env } from "@branchline/core";
import { createApp } from "./index.js";
import { InMemoryDb } from "./shim.js";

/**
 * Local dev/demo entry point. Run with e.g.:
 *   REPO_PATH=/path/to/working/repo PORT=8787 node --env-file=.dev.vars src/local-server.ts
 *
 * Uses InMemoryDb (dev/test only) and the LocalGitBackend against REPO_PATH.
 */

const REPO_PATH = process.env.REPO_PATH;
if (!REPO_PATH) {
  console.error("REPO_PATH is required (absolute path to the working git repo)");
  process.exit(1);
}

const env: Env = {
  DB: new InMemoryDb(),
  REPO_PATH,
  BL_TOKEN: process.env.BL_TOKEN || undefined,
  BL_ALLOW_ANON: process.env.BL_ALLOW_ANON || undefined,
};

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: createApp(env).fetch, port }, (info) => {
  console.log(
    `branchline api listening on http://localhost:${info.port} (repo: ${REPO_PATH})`,
  );
});
