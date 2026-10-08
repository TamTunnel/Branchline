import { Hono } from "hono";
import { buildFileOps, type Env, type FileMap, type GitBackend } from "@branchline/core";
import { readFileMap, TooManyFilesError } from "./filemap.js";

/**
 * Diff-result cache.
 * In production this should be backed by the DIFF_CACHE KV binding; when the
 * binding is absent (local dev) we fall back to this process-local Map.
 * Key: `${fromSha}..${toSha}` — resolved SHAs, never ref names, so a cached
 * diff can never go stale when a branch advances. Values are
 * JSON-serialized FileOp[].
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
    // Resolve SHAs BEFORE consulting the cache: keying on ref names would
    // serve a stale diff for up to an hour after a branch advances.
    const [fromSha, toSha] = await Promise.all([
      backend.revParse(from),
      backend.revParse(to),
    ]);
    const key = `${fromSha}..${toSha}`;
    const kv = env.DIFF_CACHE;

    const cached = kv ? await kv.get(key) : (memCache.get(key) ?? null);
    if (cached) return c.json(JSON.parse(cached));

    let fromFiles: FileMap;
    let toFiles: FileMap;
    try {
      [fromFiles, toFiles] = await Promise.all([
        readFileMap(backend, fromSha),
        readFileMap(backend, toSha),
      ]);
    } catch (err) {
      if (err instanceof TooManyFilesError) {
        return c.json({ error: err.message }, 413);
      }
      throw err;
    }
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
