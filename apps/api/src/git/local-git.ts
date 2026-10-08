import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { GitBackend } from "@branchline/core";

const AUTHOR = ["-c", "user.name=branchline", "-c", "user.email=branchline@local"];

function execFileAsync(
  file: string,
  args: readonly string[],
  options: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolvePromise({ stdout, stderr });
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

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.repoPath,
      });
      return stdout.trim();
    } catch (err) {
      const stderr =
        err instanceof Error
          ? // execFile errors carry stdout/stderr properties
            String(
              (err as unknown as { stderr?: unknown }).stderr ?? err.message,
            ).trim()
          : String(err);
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
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

  async commitAll(message: string): Promise<string> {
    await this.git(["add", "-A"]);
    await this.git([...AUTHOR, "commit", "-m", message]);
    return this.git(["rev-parse", "HEAD"]);
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
