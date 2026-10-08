import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type {
  ArtifactsBinding,
  ArtifactsRepoHandle,
  GitBackend,
} from "@branchline/core";
import { MemoryFS } from "./memory-fs.js";

/**
 * Name of Branchline's own per-branch metadata file. Every branch commits
 * its own `.branchline.json`; see the mergeDriver below for why merges
 * resolve it in favor of the merged branch.
 */
const META_FILE = ".branchline.json";

const AUTHOR = { name: "branchline", email: "branchline@local" };

/**
 * Extract the git Basic-auth secret from an Artifacts token.
 * Tokens look like `<secret>?expires=<ts>`; only the secret part is the
 * password (username is arbitrary, conventionally "x").
 */
export function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

export interface ArtifactsBackendOptions {
  artifacts: ArtifactsBinding;
  repoName: string;
  /**
   * Git remote URL for the repo (from `artifacts.create` output or the
   * dashboard). Optional: when absent we try the repo handle's own
   * `remote` property; if that is missing too, git operations fail with a
   * clear message telling the deployer to set BL_REMOTE.
   */
  remote?: string;
  /** Branch the working model starts on. Default "main". */
  defaultBranch?: string;
}

type TreeEntry = { path: string; type: string; oid: string };

/**
 * ArtifactsGitBackend — GitBackend over the Cloudflare Artifacts Workers
 * binding.
 *
 * Reads (`revParse`, `branchExists`, `listFiles`, `readFile`) prefer the
 * binding's native operations. Mutations clone the repo into an in-memory
 * filesystem (MemoryFS), apply the change with isomorphic-git, and push —
 * stateless per backend instance (one full clone, reused across the ops of
 * a single request/job). Artifacts remains the source of truth; the
 * in-memory working copy is never persisted.
 *
 * Working-tree model: `checkout` only records the target branch (validated
 * against the binding); the clone/checkout happens lazily on the next
 * mutating op. This matches how the routes use the backend
 * (checkout → writeFile → commitAll, checkout → mergeBranch).
 *
 * Tokens: a write token is minted per backend instance and cached until
 * 60s before `expiresAt`; it is never written to logs or error messages.
 */
/**
 * Merge driver used by `mergeBranch`.
 *
 * Branchline's own metadata file is per-branch bookkeeping, not agent
 * content: every branch writes its own `.branchline.json`, so it would
 * otherwise conflict on every merge. The merged branch's manifest wins —
 * the exact equivalent of `-X theirs` in LocalGitBackend. D1 remains the
 * source of truth for manifests.
 *
 * Tier-1 classification guarantees disjoint touches, so any other conflict
 * is unexpected: fail loudly instead of emitting conflict markers (agents
 * must never see raw `<<<<<<<`).
 */
export function branchlineMergeDriver({
  path,
  contents,
}: {
  path: string;
  contents: string[];
}): { cleanMerge: boolean; mergedText: string } {
  if (path === META_FILE) {
    return { cleanMerge: true, mergedText: contents[2] };
  }
  throw new Error(`unexpected merge conflict in ${path}`);
}

export class ArtifactsGitBackend implements GitBackend {
  private readonly artifacts: ArtifactsBinding;
  private readonly repoName: string;
  private readonly configuredRemote?: string;
  private currentBranch: string;

  private memfs = new MemoryFS();
  private cloned = false;
  private activeBranch: string | null = null;
  private cachedRemote: string | null = null;
  private cachedToken: { secret: string; expiresAtMs: number } | null = null;

  constructor(opts: ArtifactsBackendOptions) {
    if (!opts.artifacts) throw new Error("artifacts git: ARTIFACTS binding is required");
    if (!opts.repoName) throw new Error("artifacts git: repoName is required");
    this.artifacts = opts.artifacts;
    this.repoName = opts.repoName;
    this.configuredRemote = opts.remote;
    this.currentBranch = opts.defaultBranch ?? "main";
  }

  // ------------------------------------------------------------------ setup

  private async withRepo<T>(
    fn: (repo: ArtifactsRepoHandle) => Promise<T>,
  ): Promise<T> {
    const repo = await this.artifacts.get(this.repoName);
    try {
      return await fn(repo);
    } finally {
      const dispose = (repo as unknown as Partial<Record<symbol, unknown>>)[
        Symbol.asyncDispose
      ];
      if (typeof dispose === "function") {
        await (dispose as () => Promise<void>).call(repo);
      }
    }
  }

  /** Wrap an op failure; never leaks tokens (they are never interpolated). */
  private fail(op: string, err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`artifacts git ${op} failed: ${message}`);
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - now > 60_000) {
      return this.cachedToken.secret;
    }
    const { plaintext, expiresAt } = await this.withRepo((repo) =>
      repo.createToken("write", 3600),
    );
    const secret = tokenSecret(plaintext);
    const expiresAtMs = Date.parse(expiresAt);
    if (!secret) throw new Error("empty token plaintext");
    if (Number.isNaN(expiresAtMs)) throw new Error("unparseable token expiry");
    this.cachedToken = { secret, expiresAtMs };
    return secret;
  }

  private onAuth = async (): Promise<{ username: string; password: string }> => ({
    username: "x",
    password: await this.token(),
  });

  private async remote(): Promise<string> {
    if (this.cachedRemote) return this.cachedRemote;
    if (this.configuredRemote) {
      this.cachedRemote = this.configuredRemote;
      return this.cachedRemote;
    }
    const fromHandle = await this.withRepo(async (repo) => {
      const maybe = repo as unknown as { remote?: unknown };
      return typeof maybe.remote === "string" ? maybe.remote : null;
    });
    if (fromHandle) {
      this.cachedRemote = fromHandle;
      return fromHandle;
    }
    throw new Error(
      "no git remote known for Artifacts repo " +
        `"${this.repoName}": set BL_REMOTE (from artifacts.create output or the dashboard)`,
    );
  }

  private get fs() {
    return this.memfs;
  }

  /** Full clone once per backend instance; reused by every later op. */
  private async ensureCloned(): Promise<void> {
    if (this.cloned) return;
    try {
      const url = await this.remote();
      this.memfs = new MemoryFS();
      await git.clone({
        fs: this.memfs,
        http,
        dir: "/",
        url,
        onAuth: this.onAuth,
      });
      this.cloned = true;
      this.activeBranch = null;
    } catch (err) {
      this.fail("clone", err);
    }
  }

  /**
   * Check out `branch` in the in-memory working copy, creating a local
   * branch from the remote-tracking ref when the clone only has the remote
   * one.
   */
  private async ensureOnBranch(branch: string): Promise<void> {
    await this.ensureCloned();
    if (this.activeBranch === branch) return;
    try {
      const local = await git.listBranches({ fs: this.fs, dir: "/" });
      if (!local.includes(branch)) {
        await git.branch({
          fs: this.fs,
          dir: "/",
          ref: branch,
          object: `remotes/origin/${branch}`,
          checkout: false,
        });
      }
      await git.checkout({ fs: this.fs, dir: "/", ref: branch, force: true });
      this.activeBranch = branch;
    } catch (err) {
      this.fail("checkout", err);
    }
  }

  /** Reject paths escaping the repo; returns the memfs-absolute path. */
  private treePath(path: string): string {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`refusing to write outside repo: ${path}`);
    }
    const parts = path.split("/");
    const clean: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (clean.length === 0) {
          throw new Error(`refusing to write outside repo: ${path}`);
        }
        clean.pop();
        continue;
      }
      clean.push(part);
    }
    // Absolute paths and anything that normalized away to nothing are
    // rejected: the working tree is exactly this repo, nothing else.
    if (path.startsWith("/") || clean.length === 0) {
      throw new Error(`refusing to write outside repo: ${path}`);
    }
    return "/" + clean.join("/");
  }

  private relPath(path: string): string {
    return this.treePath(path).slice(1);
  }

  /** Stage all working-tree changes (the `git add -A` equivalent). */
  private async stageAll(): Promise<boolean> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir: "/" });
    let changed = false;
    for (const [filepath, headStatus, workdirStatus] of matrix) {
      if (workdirStatus === 2) {
        await git.add({ fs: this.fs, dir: "/", filepath });
        changed = true;
      } else if (workdirStatus === 0 && headStatus !== 0) {
        try {
          await git.remove({ fs: this.fs, dir: "/", filepath });
        } catch {
          /* already gone from the index */
        }
        changed = true;
      }
    }
    return changed;
  }

  private async pushCurrent(): Promise<void> {
    await git.push({ fs: this.fs, http, dir: "/", onAuth: this.onAuth });
  }

  // ------------------------------------------------------------------- reads

  async revParse(ref: string): Promise<string> {
    try {
      return await this.withRepo(async (repo) => {
        const entries = await repo.log({ ref, limit: 1 });
        const oid = entries?.[0]?.oid;
        if (!oid || typeof oid !== "string") {
          throw new Error(`no commit found for ref "${ref}"`);
        }
        return oid;
      });
    } catch (err) {
      this.fail("revParse", err);
    }
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.revParse(name);
      return true;
    } catch (err) {
      // Only the clean not-found signal maps to false. Transport errors,
      // auth failures, and anything else propagate — a caller must never
      // mistake an outage for a missing branch.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no commit found for ref") || msg.includes("NOT_FOUND"))
        return false;
      throw err;
    }
  }

  async listFiles(ref: string): Promise<string[]> {
    // Prefer the binding's tree walk; fall back to a clone + git.walk when
    // the binding's tree shapes are not what we expect.
    try {
      const sha = await this.revParse(ref);
      return await this.withRepo(async (repo) => {
        const commit = await repo.readCommit(sha);
        const treeOid = commit?.commit?.tree;
        if (!treeOid || typeof treeOid !== "string") {
          throw new Error("readCommit returned no tree");
        }
        const files: string[] = [];
        const walkTree = async (tree: string, prefix: string): Promise<void> => {
          const entries = normalizeTreeEntries(await repo.readTree(tree));
          for (const entry of entries) {
            if (entry.type === "tree") {
              await walkTree(entry.oid, `${prefix}${entry.path}/`);
            } else if (entry.type === "blob") {
              files.push(`${prefix}${entry.path}`);
            }
            // "commit" (submodule) entries are skipped: not agent content.
          }
        };
        await walkTree(treeOid, "");
        return files.sort();
      });
    } catch (err) {
      // Binding tree walk unavailable — walk the cloned repo instead.
      try {
        await this.ensureCloned();
        const sha = await this.revParse(ref);
        const files: string[] = [];
        await git.walk({
          fs: this.fs,
          dir: "/",
          trees: [git.TREE({ ref: sha })],
          map: async (filepath: string, entries: Array<{
            type: () => Promise<string>;
          } | null>) => {
            const entry = entries[0];
            if (!entry) return;
            if ((await entry.type()) === "blob") files.push(filepath);
          },
        });
        return files.sort();
      } catch (fallbackErr) {
        this.fail("listFiles", fallbackErr);
      }
    }
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    try {
      return await this.withRepo(async (repo) => {
        const blob = await repo.readFile({ ref, path });
        if (!blob) return null;
        return blob.text();
      });
    } catch (err) {
      this.fail("readFile", err);
    }
  }

  async mergeBase(a: string, b: string): Promise<string> {
    try {
      await this.ensureCloned();
      const bases = await git.findMergeBase({
        fs: this.fs,
        dir: "/",
        oids: [a, b],
      });
      if (!bases.length) {
        throw new Error(`no merge base between ${a} and ${b}`);
      }
      return bases[0];
    } catch (err) {
      this.fail("mergeBase", err);
    }
  }

  // --------------------------------------------------------------- mutations

  async checkout(branch: string): Promise<void> {
    // Validate against the binding, then record; the in-memory checkout
    // happens lazily on the next mutating op (working-tree model).
    try {
      await this.revParse(branch);
      this.currentBranch = branch;
    } catch (err) {
      this.fail("checkout", err);
    }
  }

  async createBranch(name: string, base: string): Promise<void> {
    try {
      await this.ensureCloned();
      await git.branch({
        fs: this.fs,
        dir: "/",
        ref: name,
        object: base,
        checkout: false,
      });
      await git.push({
        fs: this.fs,
        http,
        dir: "/",
        ref: name,
        onAuth: this.onAuth,
      });
    } catch (err) {
      this.fail("createBranch", err);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Guard first: no I/O (and no clone) happens for escaping paths.
    const abs = this.treePath(path);
    try {
      await this.ensureOnBranch(this.currentBranch);
      const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
      await this.fs.promises.mkdir(dir, { recursive: true });
      await this.fs.promises.writeFile(abs, content);
    } catch (err) {
      this.fail("writeFile", err);
    }
  }

  async commitAll(message: string): Promise<string> {
    try {
      await this.ensureOnBranch(this.currentBranch);
      const changed = await this.stageAll();
      if (!changed) throw new Error("nothing to commit");
      const sha = await git.commit({
        fs: this.fs,
        dir: "/",
        message,
        author: AUTHOR,
      });
      await this.pushCurrent();
      this.activeBranch = this.currentBranch;
      return sha;
    } catch (err) {
      this.fail("commitAll", err);
    }
  }

  async mergeBranch(branch: string, message: string): Promise<string> {
    try {
      await this.ensureOnBranch(this.currentBranch);
      // fastForward defaults to true: fast-forwards when possible, else a
      // real merge commit — the same semantics as LocalGitBackend's
      // `--ff-only` attempt followed by `--no-ff`.
      await git.merge({
        fs: this.fs,
        dir: "/",
        ours: this.currentBranch,
        theirs: `remotes/origin/${branch}`,
        message,
        author: AUTHOR,
        mergeDriver: branchlineMergeDriver,
      });
      // isomorphic-git leaves the worktree copy of driver-resolved files
      // (e.g. .branchline.json) stale after a custom-driver merge, while the
      // commit itself is correct. Re-sync the worktree to the new HEAD so a
      // later stageAll() in this backend instance cannot commit the stale
      // copy as a phantom modification.
      await git.checkout({
        fs: this.fs,
        dir: "/",
        ref: this.currentBranch,
        force: true,
      });
      await this.pushCurrent();
      return git.resolveRef({ fs: this.fs, dir: "/", ref: "HEAD" });
    } catch (err) {
      this.fail("mergeBranch", err);
    }
  }

  async applyMerge(
    files: Record<string, string | null>,
    message: string,
  ): Promise<string> {
    try {      await this.ensureOnBranch(this.currentBranch);
      for (const [path, content] of Object.entries(files)) {
        const rel = this.relPath(path);
        const abs = this.treePath(path);
        if (content === null) {
          try {
            await git.remove({ fs: this.fs, dir: "/", filepath: rel });
          } catch {
            try {
              await this.fs.promises.unlink(abs);
            } catch {
              /* already absent */
            }
          }
        } else {
          const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
          await this.fs.promises.mkdir(dir, { recursive: true });
          await this.fs.promises.writeFile(abs, content);
        }
      }
      const changed = await this.stageAll();
      if (!changed) throw new Error("nothing to commit");
      const sha = await git.commit({
        fs: this.fs,
        dir: "/",
        message,
        author: AUTHOR,
      });
      await this.pushCurrent();
      return sha;
    } catch (err) {
      this.fail("applyMerge", err);
    }
  }

  async deleteFile(path: string): Promise<void> {
    // Guard first: no I/O (and no clone) happens for escaping paths.
    const rel = this.relPath(path);
    const abs = this.treePath(path);
    try {
      await this.ensureOnBranch(this.currentBranch);
      try {
        await git.remove({ fs: this.fs, dir: "/", filepath: rel });
      } catch {
        try {
          await this.fs.promises.unlink(abs);
        } catch {
          /* already absent */
        }
      }
    } catch (err) {
      this.fail("deleteFile", err);
    }
  }

  /**
   * Atomic commit of a file set to `branch`: checkout, apply files,
   * stage, commit, push. Each backend instance owns a private in-memory
   * working copy and instances are per-request, so concurrent requests do
   * not share mutable state here (unlike LocalGitBackend's one checkout).
   */
  async commitFiles(
    branch: string,
    files: Record<string, string | null>,
    message: string,
  ): Promise<string> {
    try {
      await this.ensureOnBranch(branch);
      this.currentBranch = branch;
      for (const [path, content] of Object.entries(files)) {
        if (content === null) {
          await this.deleteFile(path);
        } else {
          const abs = this.treePath(path);
          const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
          await this.fs.promises.mkdir(dir, { recursive: true });
          await this.fs.promises.writeFile(abs, content);
        }
      }
      const changed = await this.stageAll();
      if (!changed) throw new Error("nothing to commit");
      const sha = await git.commit({
        fs: this.fs,
        dir: "/",
        message,
        author: AUTHOR,
      });
      await this.pushCurrent();
      return sha;
    } catch (err) {
      this.fail("commitFiles", err);
    }
  }

  async deleteBranch(name: string): Promise<void> {
    // The Artifacts binding exposes no ref-deletion operation and
    // isomorphic-git cannot push a ref deletion, so a remote branch cannot
    // be removed from here. The D1 row (marked `abandoned` by the caller)
    // is the source of truth; the orphaned ref is harmless. Throwing —
    // rather than silently succeeding — keeps the best-effort caller honest.
    throw new Error(
      `artifacts git deleteBranch failed: remote ref deletion is not supported for branch "${name}"`,
    );
  }
}

/** Accept the plausible readTree shapes; anything else is a hard error. */
function normalizeTreeEntries(
  tree:
    | { entries: Array<{ path: string; type: string; oid: string }> }
    | { tree: Array<{ path: string; type: string; oid: string }> },
): TreeEntry[] {
  if (Array.isArray((tree as { entries?: unknown }).entries)) {
    return (tree as { entries: TreeEntry[] }).entries;
  }
  if (Array.isArray((tree as { tree?: unknown }).tree)) {
    return (tree as { tree: TreeEntry[] }).tree;
  }
  throw new Error("unrecognized readTree shape");
}
