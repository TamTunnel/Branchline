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
  /**
   * Delete branch `name`. Best-effort cleanup for failed branch creation:
   * implementations may leave the ref behind when the platform cannot
   * delete it (callers must tolerate that; D1 is the source of truth).
   */
  deleteBranch(name: string): Promise<void>;
  /** List file paths present at `ref`. */
  listFiles(ref: string): Promise<string[]>;
  /** Read file content at `ref:path`. Null when the file does not exist. */
  readFile(ref: string, path: string): Promise<string | null>;
  /** Checkout `branch` in the working repo. */
  checkout(branch: string): Promise<void>;
  /** Write (create or overwrite) a file in the working tree. Does not commit. */
  writeFile(path: string, content: string): Promise<void>;
  /** Delete a file from the working tree. Does not commit. */
  deleteFile(path: string): Promise<void>;
  /** Stage everything and commit on the currently checked-out branch. Returns SHA. */
  commitAll(message: string): Promise<string>;
  /**
   * Commit a set of file changes to `branch` as one operation:
   * check out `branch`, apply `files` (path -> content; null deletes),
   * stage all, commit. Returns the new HEAD SHA.
   *
   * This is the atomic multi-step mutation: implementations must serialize
   * concurrent commitFiles calls against each other (LocalGitBackend shares
   * one working checkout; ArtifactsGitBackend is stateless per instance but
   * must still not interleave within an instance). Throws when there is
   * nothing to commit.
   */
  commitFiles(
    branch: string,
    files: Record<string, string | null>,
    message: string,
  ): Promise<string>;
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

/**
 * Minimal structural surface of the Cloudflare Artifacts Workers binding
 * used by Branchline. Structural typing: the real binding is assignable as
 * long as it provides at least these members. Shapes below follow the
 * Artifacts Workers docs; anything not verifiable without live credentials
 * is marked and the backend degrades to explicit errors, never silent
 * wrong behavior.
 */
export interface ArtifactsBlob {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ArtifactsRepoHandle {
  /** Mint a repo-scoped git token. `plaintext` may carry a `?expires=` suffix. */
  createToken(
    capability: string,
    ttlSeconds: number,
  ): Promise<{ plaintext: string; expiresAt: string }>;
  /** Read a file at a ref. Null when the file does not exist. */
  readFile(options: { ref: string; path: string }): Promise<ArtifactsBlob | null>;
  /** Recent commits at a ref, newest first. */
  log(options: {
    ref: string;
    limit?: number;
  }): Promise<Array<{ oid: string }>>;
  /** Read a commit object; `commit.tree` is the root tree hash. */
  readCommit(oid: string): Promise<{ commit: { tree: string } }>;
  /**
   * Read a tree object. Accepts the two plausible shapes (`entries` per the
   * docs-style naming, `tree` per isomorphic-git's naming); anything else
   * is a hard error surfaced to the caller.
   */
  readTree(oid: string): Promise<
    | { entries: Array<{ path: string; type: string; oid: string }> }
    | { tree: Array<{ path: string; type: string; oid: string }> }
  >;
  readBlob(oid: string): Promise<ArtifactsBlob | null>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface ArtifactsBinding {
  create(
    name: string,
    options?: { description?: string; setDefaultBranch?: string },
  ): Promise<{
    name: string;
    remote: string;
    defaultBranch: string;
    token: string;
  }>;
  /** Disposable repo handle (`using repo = await artifacts.get(name)`). */
  get(name: string): Promise<ArtifactsRepoHandle>;
}

/** Minimal D1 surface the API uses (subset of D1Database). */
export interface Db {  prepare(query: string): {
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
  /**
   * Set to "1" to allow unauthenticated mutating requests when BL_TOKEN is
   * unset and the ARTIFACTS binding is present. Local-dev escape hatch only;
   * without it, production (ARTIFACTS bound) fails closed with 503.
   */
  BL_ALLOW_ANON?: string;
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
  /** Optional Cloudflare Artifacts binding. When bound, `createBackend`
   *  selects the Artifacts-backed GitBackend (production path on Workers);
   *  when absent, the local git backend is used (dev/test). */
  ARTIFACTS?: ArtifactsBinding;
  /** Artifacts repo name for the git backend. Default: "branchline". */
  BL_REPO?: string;
  /**
   * Git remote URL for the Artifacts repo (from `artifacts.create` output or
   * the dashboard). Required when ARTIFACTS is bound and the binding's repo
   * handle does not expose `remote` itself.
   */
  BL_REMOTE?: string;
}
