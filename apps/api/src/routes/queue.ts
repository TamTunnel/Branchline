import { Hono } from "hono";
import type { Env } from "@branchline/core";
import { listMerges } from "../db.js";

/** Parse a stored artifact; a malformed row degrades to null, not a 500. */
function safeParseArtifact(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function registerQueueRoutes(
  app: Hono<{ Bindings: Env }>,
  env: Env,
): void {
  const db = env.DB;
  app.get("/api/queue", async (c) => {
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const rows = await listMerges(db, limit);
    // Envelope shape: this is what `bl queue` consumes.
    return c.json({
      queue: rows.map((r) => ({
        ...r,
        artifact: safeParseArtifact(r.artifact),
      })),
    });
  });
}
