import { Hono } from "hono";
import { buildFileOps, type Env, type GitBackend } from "@branchline/core";
import { readFileMap } from "./filemap.js";

/**
 * Diff-result cache.
 * In production this should be backed by the DIFF_CACHE KV binding; when the
 * binding is absent (local dev) we fall back to this process-local Map.
 * Key: `${from}..${to}`. Values are JSON-serialized FileOp[].
 */
const memCache = new Map<string, string>();

export function registerDiffRoutes(
  app: Hono<{ Bindings: Env }>,
  backend: GitBackend,
  env: Env,
): void {
  app.get("/api/diff", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) {
      return c.json({ error: "query params 'from' and 'to' are required" }, 400);
    }
    const key = `${from}..${to}`;
    const kv = env.DIFF_CACHE;

    const cached = kv ? await kv.get(key) : (memCache.get(key) ?? null);
    if (cached) return c.json(JSON.parse(cached));

    const [fromSha, toSha] = await Promise.all([
      backend.revParse(from),
      backend.revParse(to),
    ]);
    const [fromFiles, toFiles] = await Promise.all([
      readFileMap(backend, fromSha),
      readFileMap(backend, toSha),
    ]);
    const ops = buildFileOps(fromFiles, toFiles);

    const serialized = JSON.stringify(ops);
    if (kv) {
      await kv.put(key, serialized, { expirationTtl: 3600 });
    } else {
      memCache.set(key, serialized);
    }
    return c.json(ops);
  });
}
