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
import { insertBranch, listBranches } from "../db.js";
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

    await backend.createBranch(name, base);
    await backend.checkout(name);
    await backend.writeFile(".branchline.json", manifestToJson(manifest) + "\n");
    await backend.commitAll(`branchline: create ${name}`);

    await insertBranch(db, {
      name,
      intent,
      agent_id,
      touches: JSON.stringify(touches),
      base_sha: base,
      status: manifest.status,
      created_at: manifest.created_at,
    });

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
