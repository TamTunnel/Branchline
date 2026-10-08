import { Hono } from "hono";
import type { Env } from "@branchline/core";
import { createBackend } from "./git/local-git.js";
import { listBranches, listMerges } from "./db.js";
import { registerBranchesRoutes } from "./routes/branches.js";
import { registerDiffRoutes } from "./routes/diff.js";
import { processMergeJob, registerMergeRoutes, type MergeJobMessage } from "./routes/merge.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { renderDashboard } from "./dashboard.js";

/**
 * Build the Hono app.
 *
 * NOTE: createBackend selects LocalGitBackend (working git repo at REPO_PATH)
 * unless the ARTIFACTS binding is present. LocalGitBackend shells out to
 * `git`, so it only runs where a working repo and the git binary exist
 * (local dev / self-hosted). The Cloudflare Artifacts backend plugs in
 * behind the same GitBackend interface for the real Worker — route code
 * only depends on the interface.
 */
export function createApp(env: Env) {
  const backend = createBackend(env);
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

  /**
   * Queue consumer for merge jobs (production path; local dev processes
   * merges inline in POST /api/merge). Requires a working GitBackend —
   * with the Artifacts backend this runs against env.ARTIFACTS; with the
   * local backend it needs REPO_PATH, which only exists in dev.
   */
  async queue(
    batch: { messages: Array<{ body: unknown; ack(): void }> },
    env: Env,
  ) {
    const backend = createBackend(env);
    for (const msg of batch.messages) {
      const { branch, target, mergeId } = msg.body as MergeJobMessage;
      try {
        await processMergeJob(backend, env.DB, branch, target, mergeId);
        msg.ack();
      } catch {
        // processMergeJob already marked the row failed; ack to avoid
        // redelivery loops (retry via POST /api/merge).
        msg.ack();
      }
    }
  },
};
