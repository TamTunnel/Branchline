import type { Context } from "hono";
import type { Env } from "@branchline/core";

/**
 * Bearer-token guard for mutating routes.
 * Returns a JSON Response when the request must be rejected, or null when
 * it is authorized.
 *
 * - When `env.BL_TOKEN` is set: require `Authorization: Bearer <token>`.
 * - When unset AND the Artifacts binding is present (production on
 *   Workers): fail CLOSED with 503 — an unauthenticated production
 *   deployment is a misconfiguration, not a default.
 * - When unset and no ARTIFACTS binding (local dev/test): requests pass;
 *   set `BL_ALLOW_ANON=1` explicitly to keep open mode if ARTIFACTS is
 *   bound but you really want no auth (never in production).
 */
export function requireAuth(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Response | null {
  const token = env.BL_TOKEN;
  if (token) {
    const header = c.req.header("authorization") ?? "";
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !value || value !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return null;
  }
  if (env.ARTIFACTS && env.BL_ALLOW_ANON !== "1") {
    return c.json({ error: "server misconfigured: BL_TOKEN is not set" }, 503);
  }
  return null;
}
