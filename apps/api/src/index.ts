import { Hono } from "hono";
import type { Env } from "@branchline/core";
import { LocalGitBackend } from "./git/local-git.js";
import { listBranches, listMerges } from "./db.js";
import { registerBranchesRoutes } from "./routes/branches.js";
import { registerDiffRoutes } from "./routes/diff.js";
import { registerMergeRoutes } from "./routes/merge.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { renderDashboard } from "./dashboard.js";

/**
 * Build the Hono app.
 *
 * NOTE: the LocalGitBackend shells out to `git` on REPO_PATH, so it only runs
 * where a working repo and the git binary exist (local dev / self-hosted).
 * A Cloudflare Artifacts backend would be wired here instead for the real
 * Worker — the route code only depends on the GitBackend interface.
 */
export function createApp(env: Env) {
  const backend = new LocalGitBackend(env.REPO_PATH);
  const app = new Hono<{ Bindings: Env }>();

  registerBranchesRoutes(app, backend, env);
  registerDiffRoutes(app, backend, env);
  registerMergeRoutes(app, backend, env);
  registerQueueRoutes(app, env);

  app.get("/", async (c) => {
    const [branches, merges] = await Promise.all([
      listBranches(env.DB),
      listMerges(env.DB),
    ]);
    return c.html(await renderDashboard({ branches, merges }));
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => c.json({ error: err.message }, 500));

  return app;
}

export default {
  async fetch(req: Request, env: Env) {
    return createApp(env).fetch(req, env);
  },
};
