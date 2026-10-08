/**
 * ArtifactsGitBackend tests.
 *
 * Everything here runs against a fake Artifacts binding and an in-memory
 * filesystem — no network, no Workers runtime, no live Artifacts
 * credentials. What these tests establish:
 * - backend selection (ARTIFACTS bound -> ArtifactsGitBackend)
 * - token secret stripping for git Basic auth
 * - MemoryFS satisfies isomorphic-git (init/add/commit/log/merge round-trip)
 * - the .branchline.json merge driver takes theirs; other conflicts throw
 * - path-traversal writes are rejected before any I/O
 * - binding-backed reads (revParse/branchExists/readFile/listFiles)
 */
import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { MemoryFS } from "../apps/api/src/git/memory-fs.js";
import {
  ArtifactsGitBackend,
  branchlineMergeDriver,
  tokenSecret,
} from "../apps/api/src/git/artifacts-git.js";
import {
  createBackend,
  LocalGitBackend,
} from "../apps/api/src/git/local-git.js";
import type { ArtifactsBinding } from "@branchline/core";

const enc = new TextEncoder();
const asBlob = (content: string) => ({
  text: async () => content,
  arrayBuffer: async () => enc.encode(content).buffer as ArrayBuffer,
});

/** In-memory fake of the Artifacts Workers binding. */
class FakeRepo {
  refs = new Map<string, string>();
  commits = new Map<string, { tree: string }>();
  trees = new Map<string, Array<{ path: string; type: string; oid: string }>>();
  blobs = new Map<string, string>();
  fileContent = new Map<string, string>(); // `${ref}:${path}` -> content
  disposed = 0;

  async createToken() {
    return {
      plaintext: "s3cr3t?expires=9999999999",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }
  async readFile({ ref, path }: { ref: string; path: string }) {
    const c = this.fileContent.get(`${ref}:${path}`);
    return c === undefined ? null : asBlob(c);
  }
  async log({ ref }: { ref: string }) {
    const oid = this.refs.get(ref);
    return oid ? [{ oid }] : [];
  }
  async readCommit(oid: string) {
    const c = this.commits.get(oid);
    if (!c) throw new Error(`no such commit ${oid}`);
    return { commit: c };
  }
  async readTree(oid: string) {
    const e = this.trees.get(oid);
    if (!e) throw new Error(`no such tree ${oid}`);
    return { entries: e };
  }
  async readBlob(oid: string) {
    const c = this.blobs.get(oid);
    return c === undefined ? null : asBlob(c);
  }
  async [Symbol.asyncDispose]() {
    this.disposed++;
  }
}

class FakeArtifacts implements ArtifactsBinding {
  constructor(public repo: FakeRepo) {}
  async create() {
    throw new Error("not needed in tests");
  }
  async get(name: string) {
    if (name !== "test-repo") throw new Error(`no such repo ${name}`);
    return this.repo;
  }
}

function makeBackend(repo?: FakeRepo) {
  const r = repo ?? new FakeRepo();
  const artifacts = new FakeArtifacts(r);
  const backend = new ArtifactsGitBackend({
    artifacts,
    repoName: "test-repo",
  });
  return { backend, repo: r, artifacts };
}

describe("tokenSecret", () => {
  it("strips the ?expires= suffix", () => {
    expect(tokenSecret("abc123?expires=9999999999")).toBe("abc123");
  });
  it("leaves plain secrets untouched", () => {
    expect(tokenSecret("abc123")).toBe("abc123");
  });
});

describe("createBackend selection", () => {
  it("selects ArtifactsGitBackend when ARTIFACTS is bound", () => {
    const { artifacts } = makeBackend();
    const backend = createBackend({
      ARTIFACTS: artifacts,
      REPO_PATH: "/unused",
      BL_REPO: "test-repo",
    });
    expect(backend).toBeInstanceOf(ArtifactsGitBackend);
  });

  it("selects LocalGitBackend when ARTIFACTS is absent", () => {
    const backend = createBackend({ REPO_PATH: "/unused" });
    expect(backend).toBeInstanceOf(LocalGitBackend);
  });
});

describe("MemoryFS + isomorphic-git", () => {
  it("round-trips init/add/commit/log through the in-memory fs", async () => {
    const fs = new MemoryFS();
    await git.init({ fs, dir: "/" });
    await fs.promises.writeFile("/hello.txt", "hi");
    await fs.promises.mkdir("/sub", { recursive: true });
    await fs.promises.writeFile("/sub/nested.txt", "deep");
    await git.add({ fs, dir: "/", filepath: "hello.txt" });
    await git.add({ fs, dir: "/", filepath: "sub/nested.txt" });
    const sha = await git.commit({
      fs,
      dir: "/",
      message: "init",
      author: { name: "t", email: "t@t" },
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const log = await git.log({ fs, dir: "/" });
    expect(log[0].oid).toBe(sha);

    const names = await fs.promises.readdir("/sub");
    expect(names).toEqual(["nested.txt"]);

    const st = await fs.promises.stat("/hello.txt");
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.size).toBe(2);

    const dst = await fs.promises.stat("/sub");
    expect(dst.isDirectory()).toBe(true);

    // statusMatrix sees a clean tree after commit
    const matrix = await git.statusMatrix({ fs, dir: "/" });
    expect(matrix.every(([, , w]) => w === 1)).toBe(true);

    // ...and spots a new modification
    await fs.promises.writeFile("/hello.txt", "changed");
    const matrix2 = await git.statusMatrix({ fs, dir: "/" });
    const row = matrix2.find(([f]) => f === "hello.txt");
    expect(row?.[2]).toBe(2);
  });

  it("merges with the branchline driver: .branchline.json takes theirs", async () => {
    const fs = new MemoryFS();
    await git.init({ fs, dir: "/" });
    const head = await git.currentBranch({ fs, dir: "/" });
    const main = head ?? "master";

    await fs.promises.writeFile("/a.txt", "base\n");
    await fs.promises.writeFile("/.branchline.json", '{"v":"base"}');
    await git.add({ fs, dir: "/", filepath: "a.txt" });
    await git.add({ fs, dir: "/", filepath: ".branchline.json" });
    await git.commit({
      fs,
      dir: "/",
      message: "base",
      author: { name: "t", email: "t@t" },
    });

    await git.branch({ fs, dir: "/", ref: "feat", checkout: true });
    await fs.promises.writeFile("/.branchline.json", '{"v":"theirs"}');
    await git.add({ fs, dir: "/", filepath: ".branchline.json" });
    await git.commit({
      fs,
      dir: "/",
      message: "feat meta",
      author: { name: "t", email: "t@t" },
    });

    await git.checkout({ fs, dir: "/", ref: main });
    await fs.promises.writeFile("/.branchline.json", '{"v":"ours"}');
    await git.add({ fs, dir: "/", filepath: ".branchline.json" });
    await git.commit({
      fs,
      dir: "/",
      message: "main meta",
      author: { name: "t", email: "t@t" },
    });

    const result = await git.merge({
      fs,
      dir: "/",
      ours: main,
      theirs: "feat",
      message: "merge feat",
      author: { name: "t", email: "t@t" },
      mergeDriver: branchlineMergeDriver,
    });
    expect(result.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.alreadyMerged).not.toBe(true);
    // The merge commit carries theirs' manifest...
    const { blob } = await git.readBlob({
      fs,
      dir: "/",
      oid: result.oid as string,
      filepath: ".branchline.json",
    });
    expect(new TextDecoder().decode(blob)).toBe('{"v":"theirs"}');
    // ...and (as mergeBranch does) a force checkout re-syncs the worktree,
    // because isomorphic-git leaves driver-resolved files stale on disk.
    await git.checkout({ fs, dir: "/", ref: main, force: true });
    const merged = await fs.promises.readFile("/.branchline.json");
    expect(new TextDecoder().decode(merged)).toBe('{"v":"theirs"}');
  });
});

describe("branchlineMergeDriver", () => {
  it("returns theirs for .branchline.json", () => {
    expect(
      branchlineMergeDriver({
        path: ".branchline.json",
        contents: ["base", "ours", "theirs"],
      }),
    ).toEqual({ cleanMerge: true, mergedText: "theirs" });
  });

  it("throws for any other conflicting file (no markers, ever)", () => {
    expect(() =>
      branchlineMergeDriver({
        path: "src/app.ts",
        contents: ["base", "ours", "theirs"],
      }),
    ).toThrow("unexpected merge conflict in src/app.ts");
  });
});

describe("path traversal guard", () => {
  it("rejects escaping and absolute paths before any I/O", async () => {
    const { backend } = makeBackend();
    await expect(backend.writeFile("../../etc/evil", "x")).rejects.toThrow(
      "refusing to write outside repo",
    );
    await expect(backend.writeFile("/abs/path", "x")).rejects.toThrow(
      "refusing to write outside repo",
    );
    await expect(backend.writeFile("", "x")).rejects.toThrow(
      "refusing to write outside repo",
    );
    // No clone was attempted: a traversal rejection must not touch the network.
  });

  it("accepts normal nested paths (guard passes; clone then fails loudly offline)", async () => {
    const { backend } = makeBackend();
    // Guard passes, so we proceed to the clone step, which fails here
    // because there is no network — the error must be a wrapped git error,
    // not a traversal rejection.
    await expect(backend.writeFile("src/ok.ts", "x")).rejects.toThrow(
      /artifacts git writeFile failed/,
    );
  });
});

describe("binding-backed reads", () => {
  it("revParse resolves a branch via log; branchExists is true/false", async () => {
    const { backend, repo } = makeBackend();
    repo.refs.set("main", "abc123");
    await expect(backend.revParse("main")).resolves.toBe("abc123");
    await expect(backend.branchExists("main")).resolves.toBe(true);
    await expect(backend.branchExists("nope")).resolves.toBe(false);
    expect(repo.disposed).toBeGreaterThan(0); // handles were disposed
  });

  it("revParse fails clearly for unknown refs", async () => {
    const { backend } = makeBackend();
    await expect(backend.revParse("nope")).rejects.toThrow(
      "artifacts git revParse failed",
    );
  });

  it("branchExists rethrows transport errors; false only for not-found", async () => {
    const { backend } = makeBackend();
    await expect(backend.branchExists("nope")).resolves.toBe(false);
    const broken = new ArtifactsGitBackend({
      artifacts: {
        get: async () => {
          throw new Error("boom: network down");
        },
      } as unknown as ArtifactsBinding,
      repoName: "test-repo",
    });
    await expect(broken.branchExists("main")).rejects.toThrow("boom");
  });

  it("readFile returns content or null", async () => {
    const { backend, repo } = makeBackend();
    repo.fileContent.set("main:a.txt", "hello");
    await expect(backend.readFile("main", "a.txt")).resolves.toBe("hello");
    await expect(backend.readFile("main", "missing.txt")).resolves.toBeNull();
  });

  it("listFiles walks the binding tree recursively", async () => {
    const { backend, repo } = makeBackend();
    repo.refs.set("main", "c0");
    repo.commits.set("c0", { tree: "t0" });
    repo.trees.set("t0", [
      { path: "a.txt", type: "blob", oid: "b1" },
      { path: "sub", type: "tree", oid: "t1" },
    ]);
    repo.trees.set("t1", [{ path: "deep.txt", type: "blob", oid: "b2" }]);
    await expect(backend.listFiles("main")).resolves.toEqual([
      "a.txt",
      "sub/deep.txt",
    ]);
  });

  it("checkout validates the branch against the binding", async () => {
    const { backend, repo } = makeBackend();
    repo.refs.set("main", "abc123");
    await backend.checkout("main"); // no throw
    await expect(backend.checkout("nope")).rejects.toThrow(
      "artifacts git checkout failed",
    );
  });
});

describe("constructor validation", () => {
  it("requires a binding and repo name", () => {
    const { artifacts } = makeBackend();
    expect(
      () =>
        new ArtifactsGitBackend({
          artifacts: undefined as unknown as ArtifactsBinding,
          repoName: "x",
        }),
    ).toThrow("ARTIFACTS binding is required");
    expect(
      () => new ArtifactsGitBackend({ artifacts, repoName: "" }),
    ).toThrow("repoName is required");
  });
});
