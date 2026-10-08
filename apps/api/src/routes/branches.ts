import { Hono } from "hono";
import { z } from "zod";
import {
  IntentManifestSchema,
  branchNameFor,
  createManifest,
  manifestToJson,
  type Env,
  type GitBackend,
} from "@branchline/core";
import { insertBranch, listBranches, updateBranchStatus } from "../db.js";
import { requireAuth } from "../auth.js";

const CreateBranchBody = IntentManifestSchema.pick({
  intent: true,
  agent_id: true,
  touches: true,
}).extend({
  base: z
    .string()
    .regex(/^[0-9a-f]{4,64}$/i, "base must be a git SHA")
    .optional(),
});

function safeParseTouches(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function registerBranchesRoutes(
  app: Hono<{ Bindings: Env }>,
  backend: GitBackend,
  env: Env,
): void {
  const db = env.DB;
  app.post("/api/branches", async (c) => {
    const denied = requireAuth(c, env);
    if (denied) return denied;

    const parsed = CreateBranchBody.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", details: parsed.error.flatten() },
        400,
      );
    }
    const { intent, agent_id, touches } = parsed.data;

    // Default base: HEAD of main.
    const base = parsed.data.base ?? (await backend.revParse("main"));

    const manifest = createManifest({ intent, agent_id, touches, base });
    const name = branchNameFor(agent_id, intent, base);

    // Register in D1 FIRST so a git failure below can never orphan a branch:
    // the row exists before any ref does, and the failure path marks it
    // `abandoned` instead of leaving an untracked branch behind.
    await insertBranch(db, {
      name,
      intent,
      agent_id,
      touches: JSON.stringify(touches),
      base_sha: base,
      status: manifest.status,
      created_at: manifest.created_at,
    });

    let branchCreated = false;
    try {
      await backend.createBranch(name, base);
      // The ref is ours from here on; only delete it on failure paths below.
      // (If createBranch itself throws, any pre-existing ref predates this
      // request and must be left alone.)
      branchCreated = true;
      await backend.checkout(name);
      await backend.writeFile(".branchline.json", manifestToJson(manifest) + "\n");
      await backend.commitAll(`branchline: create ${name}`);
    } catch (err) {
      // No orphaned branches: the D1 row was inserted above, so mark it
      // `abandoned`. (updateBranchStatus is a harmless no-op when the insert
      // itself was what failed.)
      await updateBranchStatus(db, name, "abandoned");
      if (branchCreated) {
        try {
          await backend.deleteBranch(name);
        } catch {
          // Best effort: on Artifacts the ref may survive (no ref-deletion
          // API), but the D1 row is the source of truth and says `abandoned`.
        }
      }
      throw err;
    }

    return c.json({ name, manifest }, 201);
  });

  app.get("/api/branches", async (c) => {
    const rows = await listBranches(db);
    // Envelope + flat summary shape: this is what `bl branches` consumes.
    return c.json({
      branches: rows.map((r) => ({
        name: r.name,
        agent_id: r.agent_id,
        status: r.status,
        intent: r.intent,
        touches: safeParseTouches(r.touches),
        base: r.base_sha,
        created_at: r.created_at,
      })),
    });
  });
}
