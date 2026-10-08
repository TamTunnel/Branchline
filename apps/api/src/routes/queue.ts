import { Hono } from "hono";
import type { Env } from "@branchline/core";
import { listMerges } from "../db.js";

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
        artifact: r.artifact ? JSON.parse(r.artifact) : null,
      })),
    });
  });
}
