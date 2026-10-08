/**
 * Branchline core contracts.
 *
 * This module is the frozen interface between packages. Implementers:
 * - packages/core: diff.ts, merge.ts (pure functions over these types)
 * - apps/api: GitBackend implementation (local-git), HTTP routes, dashboard
 * - apps/cli: citty commands calling the HTTP API
 *
 * Rules: no I/O in this file or in merge.ts/diff.ts. No raw `<<<<<<<`
 * conflict markers may ever be emitted to agents — tier-3 conflicts are
 * returned as structured ConflictArtifact JSON.
 */

/** Machine-readable intent attached to every semantic branch. */
export interface IntentManifest {
  intent: string;
  agent_id: string;
  /** Glob patterns of files the agent declares it will touch, e.g. ["src/auth/**"]. */
  touches: string[];
  /** Commit SHA the branch was created from. */
  base: string;
  status: "open" | "merged" | "needs-resolution" | "abandoned";
  created_at: string; // ISO-8601
}

/** One hunk of an agent-readable diff. Line numbers are 1-based, inclusive. */
export interface DiffHunk {
  /** 'add' | 'del' — context lines are folded into the summary, not emitted. */
  type: "add" | "del";
  /** [start, end] in the file side the hunk applies to (new file for add, old for del). */
  lines: [number, number];
  text: string[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/** Agent-readable per-file diff operation. */
export interface FileOp {
  file: string;
  status: FileStatus;
  hunks: DiffHunk[];
  /** One-line human/agent summary, e.g. "+12 -3 in login handler". */
  summary: string;
}

/** Deterministic merge tiers. */
export type MergeTier = 1 | 2 | 3;

export type MergeStatus = "merged" | "needs-resolution" | "failed";

/** Structured conflict artifact — tier 3. Never contains raw conflict markers. */
export interface ConflictArtifact {
  file: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  ours_manifest: IntentManifest;
  theirs_manifest: IntentManifest;
  /** Line ranges (1-based, in base) where the two sides overlap. */
  overlapping_ranges: Array<[number, number]>;
}

export interface MergeDecision {
  tier: MergeTier;
  status: MergeStatus;
  /** Files merged cleanly (tiers 1-2). */
  merged_files: string[];
  /** Tier-3 artifacts, one per conflicting file. Empty unless status is needs-resolution. */
  conflicts: ConflictArtifact[];
  /** SHA of the merge commit, when status is merged. */
  merge_sha?: string;
}

/**
 * Abstraction over git operations. The MVP ships LocalGitBackend (shells out
 * to the git binary against a working repo). A Cloudflare Artifacts backend
 * implements this same interface later — no caller may depend on git CLI
 * specifics beyond this surface.
 *
 * Working-tree model: mutating ops (checkout, stageAll, commitAll,
 * mergeBranch, applyMerge) act on the backend's working repo, which the
 * merge worker keeps on the target branch (main) between jobs.
 */
export interface GitBackend {
  /** Resolve a ref (branch, tag, SHA) to a full SHA. */
  revParse(ref: string): Promise<string>;
  branchExists(name: string): Promise<boolean>;
  /** Create branch `name` at `base` ref. */
  createBranch(name: string, base: string): Promise<void>;
  /** List file paths present at `ref`. */
  listFiles(ref: string): Promise<string[]>;
  /** Read file content at `ref:path`. Null when the file does not exist. */
  readFile(ref: string, path: string): Promise<string | null>;
  /** Checkout `branch` in the working repo. */
  checkout(branch: string): Promise<void>;
  /** Write (create or overwrite) a file in the working tree. Does not commit. */
  writeFile(path: string, content: string): Promise<void>;
  /** Stage everything and commit on the currently checked-out branch. Returns SHA. */
  commitAll(message: string): Promise<string>;
  /**
   * Merge `branch` into the currently checked-out branch.
   * Tier 1: fast-forward when possible, else --no-ff merge commit.
   * Returns the resulting HEAD SHA.
   */
  mergeBranch(branch: string, message: string): Promise<string>;
  /**
   * Apply a tier-2 merge result: overwrite working tree files with `files`
   * (path -> content; null deletes), stage all, commit. Returns SHA.
   * The working repo must already be checked out on the target branch with
   * the branch's base as merge-base — the caller (merge route) guarantees this.
   */
  applyMerge(files: Record<string, string | null>, message: string): Promise<string>;
  /** Merge-base of two refs. */
  mergeBase(a: string, b: string): Promise<string>;
}

/** Minimal D1 surface the API uses (subset of D1Database). */
export interface Db {
  prepare(query: string): {
    bind(...params: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ success: boolean }>;
    };
  };
}

/** Worker environment. In production DB is a real D1 binding; REPO_PATH is set via vars. */
export interface Env {
  DB: Db;
  /** Absolute path to the working git repo the local backend operates on. */
  REPO_PATH: string;
  /** Optional repo-scoped token; when set, mutating routes require `Authorization: Bearer <token>`. */
  BL_TOKEN?: string;
  /** Optional KV binding for diff caching (stub: in-memory fallback when absent). */
  DIFF_CACHE?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  };
  /** Optional queue producer for merge jobs. When bound, POST /api/merge
   *  enqueues and returns 202; the queue consumer processes the job.
   *  When absent (local dev), merges are processed inline. */
  MERGE_QUEUE?: {
    send(message: unknown): Promise<void>;
  };
  /** Optional Cloudflare Artifacts binding (future GitBackend). When bound,
   *  createBackend selects the Artifacts-backed implementation; until that
   *  implementation lands it throws a clear error. */
  ARTIFACTS?: unknown;
}
