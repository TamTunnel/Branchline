import { z } from "zod";
import type { IntentManifest } from "./types.js";

/** Zod schema for the machine-readable intent manifest. */
export const IntentManifestSchema = z.object({
  intent: z.string().min(1).max(500),
  agent_id: z.string().min(1).max(100),
  touches: z.array(z.string().min(1)).min(1),
  base: z.string().regex(/^[0-9a-f]{4,64}$/i, "base must be a git SHA"),
  status: z.enum(["open", "merged", "needs-resolution", "abandoned"]).default("open"),
  created_at: z.string().datetime(),
});

export type IntentManifestInput = z.input<typeof IntentManifestSchema>;

/** Validate unknown input into an IntentManifest. Throws ZodError on failure. */
export function parseManifest(input: unknown): IntentManifest {
  return IntentManifestSchema.parse(input) as IntentManifest;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Deterministic branch name: bl/<agent>-<intent-slug>-<base6>-<rand4>.
 * Example: bl/agent-1-add-oauth-login-a1b2c3-9f2e
 */
export function branchNameFor(agentId: string, intent: string, baseSha: string): string {
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `bl/${slugify(agentId)}-${slugify(intent)}-${baseSha.slice(0, 6)}-${rand}`;
}

/** Build a validated manifest for a new branch. */
export function createManifest(input: {
  intent: string;
  agent_id: string;
  touches: string[];
  base: string;
}): IntentManifest {
  return parseManifest({
    ...input,
    status: "open",
    created_at: new Date().toISOString(),
  });
}

/** Serialize a manifest for `.branchline.json` and the D1 row. */
export function manifestToJson(m: IntentManifest): string {
  return JSON.stringify(m, null, 2);
}
