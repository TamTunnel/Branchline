#!/usr/bin/env node
/**
 * `bl` — the Branchline CLI.
 *
 * Thin citty wrapper over the Branchline HTTP API (apps/api), plus a local
 * `bl commit` helper that stages and commits through the system git binary.
 *
 * Global options (also readable from env):
 *   --api <url>     API base URL. Default: $BL_API or http://127.0.0.1:8787
 *   --token <tok>   Bearer token for auth. Default: $BL_TOKEN
 *
 * Note: citty parses options per subcommand, so these must be passed after
 * the subcommand name (e.g. `bl branch --api <url> ...`), or set via env.
 */
import { spawnSync } from "node:child_process";
import { defineCommand, runMain } from "citty";
import type { ConflictArtifact, FileOp } from "@branchline/core";

const DEFAULT_API = process.env.BL_API ?? "http://127.0.0.1:8787";
const DEFAULT_TOKEN = process.env.BL_TOKEN ?? "";

/** Shared --api / --token options, spread into every subcommand that hits the API. */
const globalArgs = {
  api: {
    type: "string" as const,
    description: `Branchline API base URL (env BL_API; default ${DEFAULT_API})`,
    default: DEFAULT_API,
  },
  token: {
    type: "string" as const,
    description: "Bearer token for API auth (env BL_TOKEN)",
    default: DEFAULT_TOKEN,
  },
} as const;

interface GlobalOpts {
  api: string;
  token: string;
}

function globals(args: Record<string, string | boolean | string[]>): GlobalOpts {
  const api = typeof args.api === "string" && args.api ? args.api : DEFAULT_API;
  const token = typeof args.token === "string" ? args.token : DEFAULT_TOKEN;
  return { api, token };
}

/** Print an API/CLI error to stderr and exit 1. Never returns. */
function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Extract a human-readable message from a non-2xx response body. */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText || "request failed";
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof data.error === "string" && data.error) return data.error;
    if (typeof data.message === "string" && data.message) return data.message;
  } catch {
    // not JSON — fall through to raw text
  }
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Call the API; on non-2xx or network failure, print `error: ...` and exit 1. */
async function apiFetch<T>(
  method: "GET" | "POST",
  g: GlobalOpts,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, g.api).toString();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (g.token) headers.authorization = `Bearer ${g.token}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    fail(`network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    fail(`${res.status} ${await errorMessage(res)}`);
  }
  return (await res.json()) as T;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

/** Summarize a FileOp's hunks as "+N -M". */
function countChanges(op: FileOp): string {
  let adds = 0;
  let dels = 0;
  for (const hunk of op.hunks) {
    const n = Math.max(0, hunk.lines[1] - hunk.lines[0] + 1);
    if (hunk.type === "add") adds += n;
    else dels += n;
  }
  return `+${adds} -${dels}`;
}

// ---------------------------------------------------------------------------
// bl branch
// ---------------------------------------------------------------------------
const branchCmd = defineCommand({
  meta: {
    name: "branch",
    description: "Create a semantic branch for an agent task",
  },
  args: {
    intent: {
      type: "string",
      required: true,
      description: "What the agent intends to do",
    },
    touches: {
      type: "string",
      required: true,
      description: 'Comma-separated glob patterns of files the agent will touch, e.g. "src/a/**,src/b/**"',
    },
    agent: {
      type: "string",
      required: true,
      description: "Agent id owning the branch",
    },
    base: {
      type: "string",
      description: "Base commit SHA (defaults to the target's HEAD)",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const g = globals(args);
    const touches = args.touches
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const res = await apiFetch<{ name: string; manifest: unknown }>("POST", g, "/api/branches", {
      intent: args.intent,
      agent_id: args.agent,
      touches,
      ...(args.base ? { base: args.base } : {}),
    });
    console.log(`created ${res.name}`);
  },
});

// ---------------------------------------------------------------------------
// bl commit
// ---------------------------------------------------------------------------
const commitCmd = defineCommand({
  meta: {
    name: "commit",
    description:
      "Stage all changes and commit via git (the documented way agents commit on a branchline branch)",
  },
  args: {
    message: {
      type: "string",
      alias: "m",
      required: true,
      description: "Commit message",
    },
    repo: {
      type: "string",
      description: "Repo path (default: current directory)",
    },
  },
  run({ args }) {
    const repo = args.repo || process.cwd();
    // stdio: inherit so the user sees git's own output.
    const add = spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "inherit" });
    if (add.status !== 0) process.exit(add.status ?? 1);
    const commit = spawnSync("git", ["-C", repo, "commit", "-m", args.message], {
      stdio: "inherit",
    });
    if (commit.status !== 0) process.exit(commit.status ?? 1);
  },
});

// ---------------------------------------------------------------------------
// bl branches
// ---------------------------------------------------------------------------
interface BranchSummary {
  name: string;
  intent: string;
  agent_id: string;
  touches: string[];
  status: string;
  base: string;
  created_at: string;
}

const branchesCmd = defineCommand({
  meta: { name: "branches", description: "List semantic branches" },
  args: { ...globalArgs },
  async run({ args }) {
    const g = globals(args);
    const res = await apiFetch<{ branches: BranchSummary[] }>("GET", g, "/api/branches");
    printTable(
      ["NAME", "AGENT", "STATUS", "INTENT"],
      res.branches.map((b) => [b.name, b.agent_id, b.status, truncate(b.intent, 60)]),
    );
  },
});

// ---------------------------------------------------------------------------
// bl diff
// ---------------------------------------------------------------------------
const diffCmd = defineCommand({
  meta: { name: "diff", description: "Show an agent-readable diff between two refs" },
  args: {
    from: { type: "string", required: true, description: "Base ref" },
    to: { type: "string", required: true, description: "Target ref" },
    json: { type: "boolean", description: "Print raw JSON FileOp array" },
    ...globalArgs,
  },
  async run({ args }) {
    const g = globals(args);
    const path =
      `/api/diff?from=${encodeURIComponent(args.from)}` +
      `&to=${encodeURIComponent(args.to)}`;
    const ops = await apiFetch<FileOp[]>("GET", g, path);
    if (args.json) {
      console.log(JSON.stringify(ops, null, 2));
      return;
    }
    for (const op of ops) {
      console.log(`${op.file} (${op.status}): ${countChanges(op)}`);
    }
  },
});

// ---------------------------------------------------------------------------
// bl merge
// ---------------------------------------------------------------------------
interface MergeResult {
  tier: number;
  status: string;
  merged_files: string[];
  conflicts: ConflictArtifact[];
  merge_sha?: string;
}

const mergeCmd = defineCommand({
  meta: { name: "merge", description: "Merge a branch into its target" },
  args: {
    branch: {
      type: "positional",
      required: true,
      description: "Branch to merge",
    },
    target: {
      type: "string",
      default: "main",
      description: "Target branch (default: main)",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const g = globals(args);
    const res = await apiFetch<MergeResult>("POST", g, "/api/merge", {
      branch: args.branch,
      target: args.target,
    });
    console.log(`tier=${res.tier} status=${res.status}`);
    console.log(`merged ${res.merged_files.length} file(s)`);
    if (res.status === "needs-resolution") {
      for (const c of res.conflicts) {
        // Paths + ranges only — never raw file contents with conflict markers.
        const ranges = c.overlapping_ranges.map(([a, b]) => `${a}-${b}`).join(", ");
        console.log(`conflict: ${c.file} overlapping ranges: ${ranges}`);
      }
    }
    if (res.merge_sha) console.log(`merge_sha=${res.merge_sha}`);
  },
});

// ---------------------------------------------------------------------------
// bl queue
// ---------------------------------------------------------------------------
interface QueueJob {
  id: string;
  branch: string;
  target: string;
  tier: number;
  status: string;
  created_at: string;
}

const queueCmd = defineCommand({
  meta: { name: "queue", description: "List pending merge-queue jobs" },
  args: { ...globalArgs },
  async run({ args }) {
    const g = globals(args);
    const res = await apiFetch<{ queue: QueueJob[] }>("GET", g, "/api/queue");
    printTable(
      ["ID", "BRANCH", "TIER", "STATUS"],
      res.queue.map((q) => [q.id, q.branch, String(q.tier), q.status]),
    );
  },
});

// ---------------------------------------------------------------------------
const main = defineCommand({
  meta: {
    name: "bl",
    version: "0.1.0",
    description: "Branchline CLI — semantic branches for coding agents",
  },
  args: { ...globalArgs },
  subCommands: {
    branch: branchCmd,
    commit: commitCmd,
    branches: branchesCmd,
    diff: diffCmd,
    merge: mergeCmd,
    queue: queueCmd,
  },
  // No `run` here: citty fires the parent `run` even when a subcommand was
  // dispatched, so omitting it keeps subcommand output clean. With no
  // subcommand, citty reports "No command specified." and shows usage.
});

runMain(main).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
