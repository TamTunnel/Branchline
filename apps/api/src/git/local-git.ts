import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ArtifactsBinding, GitBackend } from "@branchline/core";
import { ArtifactsGitBackend } from "./artifacts-git.js";

const AUTHOR = ["-c", "user.name=branchline", "-c", "user.email=branchline@local"];

function execFileAsync(
  file: string,
  args: readonly string[],
  options: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        // Node's execFile error does not carry stdout/stderr on the error
        // object itself; attach them so callers can report git's output
        // (git prints some failures, e.g. "nothing to commit", on stdout).
        const enriched = error as Error & {
          stdout?: string;
          stderr?: string;
        };
        enriched.stdout = stdout;
        enriched.stderr = stderr;
        reject(enriched);
      } else resolvePromise({ stdout, stderr });
    });
  });
}

/**
 * LocalGitBackend — GitBackend implemented by shelling out to the `git`
 * binary against a working repo at `repoPath`.
 *
 * Working-tree model: mutating ops act on the backend's working repo, which
 * the merge route keeps on the target branch (main) between jobs.
 */
export class LocalGitBackend implements GitBackend {
  constructor(private readonly repoPath: string) {}

  /**
   * Serializes multi-step mutations (commitFiles, and the createBranch
   * sequence in the routes) that share this one working checkout. Without
   * it, two concurrent requests could interleave checkout/write/commit and
   * land files on the wrong branch. Single-process only: this is the
   * "local backend = single-user dev" caveat, documented in README/DEPLOY.
   */
  private mutex: Promise<void> = Promise.resolve();

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release: () => void = () => {};
    this.mutex = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.repoPath,
      });
      return stdout.trim();
    } catch (err) {
      // execFile errors carry stdout/stderr properties; git reports some
      // failures (e.g. "nothing to commit") on stdout, so include both.
      const detail =
        err instanceof Error
          ? [
              (err as unknown as { stderr?: unknown }).stderr,
              (err as unknown as { stdout?: unknown }).stdout,
            ]
              .map((s) => String(s ?? "").trim())
              .filter((s) => s.length > 0)
              .join("\n") || err.message
          : String(err);
      throw new Error(`git ${args.join(" ")} failed: ${detail.trim()}`);
    }
  }

  /** Resolve a repo-relative path, rejecting escapes from the working repo. */
  private treePath(path: string): string {
    const abs = resolve(this.repoPath, path);
    if (abs !== this.repoPath && !abs.startsWith(this.repoPath + sep)) {
      throw new Error(`refusing to write outside repo: ${path}`);
    }
    return abs;
  }

  async revParse(ref: string): Promise<string> {
    return this.git(["rev-parse", "--verify", ref]);
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async createBranch(name: string, base: string): Promise<void> {
    await this.git(["branch", name, base]);
  }

  async listFiles(ref: string): Promise<string[]> {
    const out = await this.git(["ls-tree", "-r", "--name-only", ref]);
    return out.split("\n").filter((line) => line.length > 0);
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["show", `${ref}:${path}`], {
        cwd: this.repoPath,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  async checkout(branch: string): Promise<void> {
    await this.git(["checkout", branch]);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.treePath(path);
    await mkdir(dirname(abs), { recursive: true });
    await fsWriteFile(abs, content);
  }

  async deleteFile(path: string): Promise<void> {
    const abs = this.treePath(path);
    try {
      await this.git(["rm", "-q", "--", path]);
    } catch {
      // Untracked or already gone: remove from the working tree directly.
      try {
        await unlink(abs);
      } catch {
        /* already absent */
      }
    }
  }

  async commitAll(message: string): Promise<string> {
    await this.git(["add", "-A"]);
    await this.git([...AUTHOR, "commit", "-m", message]);
    return this.git(["rev-parse", "HEAD"]);
  }

  /**
   * Atomic commit of a file set to `branch`. The whole
   * checkout -> write -> commit sequence holds the backend mutex so
   * concurrent commitFiles calls cannot interleave on the shared checkout.
   */
  async commitFiles(
    branch: string,
    files: Record<string, string | null>,
    message: string,
  ): Promise<string> {
    return this.locked(async () => {
      await this.checkout(branch);
      for (const [path, content] of Object.entries(files)) {
        if (content === null) await this.deleteFile(path);
        else await this.writeFile(path, content);
      }
      return this.commitAll(message);
    });
  }

  async deleteBranch(name: string): Promise<void> {
    // Cannot delete the checked-out branch: detach HEAD first (best effort;
    // the merge route re-checkouts its target before mutating anyway).
    try {
      await this.git(["checkout", "-q", "--detach", "HEAD"]);
    } catch {
      /* ignore */
    }
    await this.git(["branch", "-D", name]);
  }

  async mergeBranch(branch: string, message: string): Promise<string> {
    try {
      await this.git(["merge", "--ff-only", branch]);
    } catch {
      // Not fast-forwardable: fall back to an explicit merge commit.
      // `-X theirs` resolves branchline's own `.branchline.json` metadata
      // file (added independently by every branch) in favor of the merged
      // branch. Tier-1 classification guarantees all other changed files are
      // disjoint, so the strategy option cannot affect agent content.
      await this.git(["merge", "--no-ff", "-X", "theirs", "-m", message, branch]);
    }
    return this.git(["rev-parse", "HEAD"]);
  }

  async applyMerge(
    files: Record<string, string | null>,
    message: string,
  ): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      const abs = this.treePath(path);
      if (content === null) {
        try {
          await this.git(["rm", "-q", "--", path]);
        } catch {
          // Untracked or already gone: remove from the working tree directly.
          try {
            await unlink(abs);
          } catch {
            /* already absent */
          }
        }
      } else {
        await mkdir(dirname(abs), { recursive: true });
        await fsWriteFile(abs, content);
      }
    }
    await this.git(["add", "-A"]);
    await this.git([...AUTHOR, "commit", "-m", message]);
    return this.git(["rev-parse", "HEAD"]);
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return this.git(["merge-base", a, b]);
  }
}

/**
 * Select the GitBackend for this environment.
 *
 * When the Cloudflare Artifacts binding is present, the production
 * ArtifactsGitBackend is used (Workers + Artifacts: repos as a service,
 * mutations via isomorphic-git over an in-memory filesystem). Otherwise the
 * LocalGitBackend is used (working git repo at REPO_PATH: local dev / tests).
 */
export function createBackend(env: {
  ARTIFACTS?: ArtifactsBinding;
  REPO_PATH: string;
  BL_REPO?: string;
  BL_REMOTE?: string;
}): GitBackend {
  if (env.ARTIFACTS) {
    return new ArtifactsGitBackend({
      artifacts: env.ARTIFACTS,
      repoName: env.BL_REPO ?? "branchline",
      remote: env.BL_REMOTE,
    });
  }
  return new LocalGitBackend(env.REPO_PATH);
}
