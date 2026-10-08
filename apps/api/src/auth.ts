import type { Context } from "hono";
import type { Env } from "@branchline/core";

/**
 * Bearer-token guard for mutating routes.
 * Returns a 401 JSON Response when auth fails, or null when the request is
 * authorized. When env.BL_TOKEN is unset, all requests pass (local dev).
 */
export function requireAuth(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Response | null {
  const token = env.BL_TOKEN;
  if (!token) return null;
  const header = c.req.header("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value || value !== token) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}
