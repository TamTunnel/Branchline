import { Hono } from "hono";
import { z } from "zod";
import type { Env, GitBackend } from "@branchline/core";
import { getBranch } from "../db.js";
import { requireAuth } from "../auth.js";

const CommitBody = z.object({
  /** path -> content; null deletes the file. */
  files: z.record(z.string(), z.union([z.string(), z.null()])),
  message: z.string().min(1).max(500),
  /**
   * Optional optimistic-concurrency guard: the sha the caller based its
   * file collection on. When supplied and != the branch's current sha,
   * the commit is refused with 409. Best-effort (check-then-act); without
   * it, concurrent commits to one branch are last-writer-wins.
   */
  expected_sha: z.string().optional(),
});

/**
 * POST /api/branches/:name/commit — the production commit path.
 *
 * Agents never touch the server's git working copy directly: they POST the
 * files they changed and the server commits them to the branch atomically
 * (GitBackend.commitFiles). This is what makes Branchline work on Workers,
 * where there is no shared filesystem — `bl commit` in the CLI is a thin
 * wrapper over this endpoint.
 */
export function registerCommitRoutes(
  app: Hono<{ Bindings: Env }>,
  backend: GitBackend,
  env: Env,
): void {
  app.post("/api/branches/:name/commit", async (c) => {
    const denied = requireAuth(c, env);
    if (denied) return denied;

    const name = c.req.param("name");
    const row = await getBranch(env.DB, name);
    if (!row) return c.json({ error: `branch not found: ${name}` }, 404);
    // A branch awaiting resolution is still live: resolving a tier-3
    // conflict means committing the fix to the SAME branch and merging
    // again. Only terminal states (merged/abandoned) refuse new commits.
    if (row.status !== "open" && row.status !== "needs-resolution") {
      return c.json(
        { error: `branch is ${row.status}; refusing to commit` },
        409,
      );
    }

    const parsed = CommitBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", details: parsed.error.flatten() },
        400,
      );
    }
    const { files, message, expected_sha } = parsed.data;
    if (Object.keys(files).length === 0) {
      return c.json({ error: "files must not be empty" }, 400);
    }
    if (Object.keys(files).length > 500) {
      return c.json({ error: "too many files in one commit (max 500)" }, 413);
    }
    if (expected_sha) {
      const current = await backend.revParse(name);
      if (current !== expected_sha) {
        return c.json(
          { error: `branch moved: expected ${expected_sha}, is ${current}` },
          409,
        );
      }
    }

    try {
      const sha = await backend.commitFiles(name, files, message);
      return c.json({ sha }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/nothing to commit/i.test(msg)) {
        return c.json({ error: "nothing to commit" }, 422);
      }
      if (/refusing to write outside repo|invalid path/i.test(msg)) {
        return c.json({ error: msg }, 400);
      }
      throw err;
    }
  });
}
