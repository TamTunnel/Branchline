import { Hono } from "hono";
import { z } from "zod";
import {
  decideMerge,
  mergedFileContents,
  type Db,
  type Env,
  type GitBackend,
  type IntentManifest,
  type MergeDecision,
} from "@branchline/core";
import {
  enqueueMerge,
  getBranch,
  updateBranchStatus,
  updateMerge,
} from "../db.js";
import { requireAuth } from "../auth.js";
import { changedFileSet, readFileMap } from "./filemap.js";

const MergeBody = z.object({
  branch: z.string().min(1),
  target: z.string().min(1).default("main"),
});

export interface MergeJobMessage {
  branch: string;
  target: string;
  mergeId: number;
}

export type MergeJobResult = MergeDecision & { merge_sha?: string };

/**
 * Run one merge job: classify the tier, apply tiers 1-2 to the working repo,
 * or record a structured tier-3 conflict artifact. Never throws without
 * first marking the merges row `failed` — safe to call from the queue
 * consumer as well as the inline HTTP path.
 */
export async function processMergeJob(
  backend: GitBackend,
  db: Db,
  branch: string,
  target: string,
  mergeId: number,
): Promise<MergeJobResult> {
  const fail = async (message: string): Promise<never> => {
    await updateMerge(db, mergeId, {
      status: "failed",
      artifact: JSON.stringify({ error: message }),
    });
    throw new Error(message);
  };

  try {
    const row = await getBranch(db, branch);
    if (!row) {
      await updateMerge(db, mergeId, {
        status: "failed",
        artifact: JSON.stringify({ error: `branch not found: ${branch}` }),
      });
      throw new Error(`branch not found: ${branch}`);
    }

    // Resolve refs and build FileMaps.
    const branchHead = await backend.revParse(branch);
    const targetHead = await backend.revParse(target);
    // Use mergeBase(branchHead, targetHead) for correctness rather than the
    // stale manifest base: the target may have advanced since branch creation.
    const base = await backend.mergeBase(branchHead, targetHead);
    const [baseFiles, oursFiles, theirsFiles] = await Promise.all([
      readFileMap(backend, base),
      readFileMap(backend, branchHead),
      readFileMap(backend, targetHead),
    ]);

    // Branchline's own metadata file is per-branch bookkeeping, not agent
    // content: every branch adds its own .branchline.json, so it would
    // otherwise force every merge to tier >= 2. Exclude it from tier
    // classification. (D1 remains the source of truth for manifests;
    // tier-1 git merges resolve the file with `-X theirs`, see local-git.)
    for (const m of [baseFiles, oursFiles, theirsFiles]) {
      m.delete(".branchline.json");
    }

    const oursTouches: string[] = JSON.parse(row.touches);
    const theirsChanged = [...changedFileSet(baseFiles, theirsFiles)];
    const oursManifest: IntentManifest = {
      intent: row.intent,
      agent_id: row.agent_id,
      touches: oursTouches,
      base: row.base_sha,
      status: row.status as IntentManifest["status"],
      created_at: row.created_at,
    };
    const theirsManifest: IntentManifest = {
      intent: "mainline integration",
      agent_id: "branchline",
      touches: theirsChanged,
      base,
      status: "merged",
      created_at: new Date().toISOString(),
    };

    const decideArgs = {
      baseFiles,
      oursFiles,
      theirsFiles,
      oursManifest,
      theirsManifest,
      oursTouches,
      theirsTouches: theirsChanged,
    };
    const decision = decideMerge(decideArgs);

    if (decision.tier === 1) {
      await backend.checkout(target);
      const sha = await backend.mergeBranch(
        branch,
        `branchline: merge ${branch} into ${target}`,
      );
      await updateMerge(db, mergeId, {
        tier: 1,
        status: "merged",
        merge_sha: sha,
      });
      await updateBranchStatus(db, branch, "merged");
      return { ...decision, merge_sha: sha };
    }

    if (decision.tier === 2) {
      await backend.checkout(target);
      const sha = await backend.applyMerge(
        mergedFileContents(decideArgs),
        `branchline: merge ${branch} into ${target} (tier 2)`,
      );
      await updateMerge(db, mergeId, {
        tier: 2,
        status: "merged",
        merge_sha: sha,
      });
      await updateBranchStatus(db, branch, "merged");
      return { ...decision, merge_sha: sha };
    }

    // Tier 3: do NOT touch the working tree. The structured conflict
    // artifact is stored on the merges row for the agent to resolve.
    await updateMerge(db, mergeId, {
      tier: 3,
      status: "needs-resolution",
      artifact: JSON.stringify({ conflicts: decision.conflicts }),
    });
    await updateBranchStatus(db, branch, "needs-resolution");
    return decision;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("branch not found")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

export function registerMergeRoutes(
  app: Hono<{ Bindings: Env }>,
  backend: GitBackend,
  env: Env,
): void {
  const db = env.DB;
  app.post("/api/merge", async (c) => {
    const denied = requireAuth(c, env);
    if (denied) return denied;

    const parsed = MergeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", details: parsed.error.flatten() },
        400,
      );
    }
    const { branch, target } = parsed.data;

    // 1. Load the branch row.
    const row = await getBranch(db, branch);
    if (!row) return c.json({ error: `branch not found: ${branch}` }, 404);

    // 2. Enqueue the merge job row.
    const mergeId = await enqueueMerge(db, {
      branch,
      base: row.base_sha,
      target,
    });

    // 3. Production: hand the job to the queue consumer and return 202.
    //    Local dev (no MERGE_QUEUE binding): process inline, synchronously.
    if (env.MERGE_QUEUE) {
      const msg: MergeJobMessage = { branch, target, mergeId };
      await env.MERGE_QUEUE.send(msg);
      return c.json({ status: "queued", id: mergeId }, 202);
    }

    try {
      const result = await processMergeJob(backend, db, branch, target, mergeId);
      return c.json(result);
    } catch (err) {
      // The branch stays open so the job can be retried.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "merge failed", detail: message }, 500);
    }
  });
}
