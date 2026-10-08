/**
 * MemoryFS — a minimal in-memory filesystem for isomorphic-git.
 *
 * Clean-room implementation (not derived from any vendor example): it only
 * needs to satisfy the subset of node's `fs.promises` that isomorphic-git
 * touches (readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat,
 * readlink, symlink, chmod). Paths are POSIX-style; the backend mounts the
 * repo at "/".
 *
 * Errors carry node-style `.code` properties (ENOENT, ENOTDIR, EEXIST,
 * ENOTEMPTY, EISDIR) because isomorphic-git's FileSystem wrapper branches
 * on them (e.g. `exists()` treats ENOENT/ENOTDIR as "missing").
 */

type DirNode = {
  kind: "dir";
  children: Map<string, FsNode>;
  mode: number;
  ctimeMs: number;
  mtimeMs: number;
};
type FileNode = {
  kind: "file";
  content: Uint8Array;
  mode: number;
  ctimeMs: number;
  mtimeMs: number;
};
type LinkNode = {
  kind: "symlink";
  target: string;
  mode: number;
  ctimeMs: number;
  mtimeMs: number;
};
type FsNode = DirNode | FileNode | LinkNode;

export interface FsStat {
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mtime: Date;
  ctime: Date;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function fsError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Normalize to an absolute POSIX path ("/a/b"). Throws on null bytes. */
function normalize(path: string): string {
  if (path.includes("\0")) throw fsError("EINVAL", `invalid path: ${path}`);
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return "/" + out.join("/");
}

const encoder = new TextEncoder();

export class MemoryFS {
  private root: DirNode = {
    kind: "dir",
    children: new Map(),
    mode: 0o040755,
    ctimeMs: Date.now(),
    mtimeMs: Date.now(),
  };
  private inoCounter = 1;

  /**
   * The promises-style client isomorphic-git consumes
   * (`new FileSystem(fs)` reads `fs.promises`). Arrow functions so the
   * methods stay bound when isomorphic-git destructures them.
   */
  readonly promises = {
    readFile: async (
      path: string,
      options?: string | { encoding?: string },
    ): Promise<Uint8Array | string> => {
      const node = this.lookup(normalize(path), false);
      if (!node) throw fsError("ENOENT", `ENOENT: no such file '${path}'`);
      if (node.kind === "dir")
        throw fsError("EISDIR", `EISDIR: illegal operation on a directory '${path}'`);
      let bytes: Uint8Array;
      if (node.kind === "symlink") {
        bytes = await this.promises.readFile(
          this.resolveLink(normalize(path), node.target),
          options,
        ).then((r) => (typeof r === "string" ? encoder.encode(r) : r));
      } else {
        bytes = node.content.slice();
      }
      const encoding =
        typeof options === "string" ? options : options?.encoding;
      if (encoding === "utf8" || encoding === "utf-8") {
        return new TextDecoder("utf-8").decode(bytes);
      }
      return bytes;
    },

    writeFile: async (
      path: string,
      data: Uint8Array | string,
    ): Promise<void> => {
      const norm = normalize(path);
      const parent = this.parentDir(norm, false);
      const name = norm.slice(norm.lastIndexOf("/") + 1);
      const existing = parent.children.get(name);
      if (existing?.kind === "dir")
        throw fsError("EISDIR", `EISDIR: illegal operation on a directory '${path}'`);
      const bytes =
        typeof data === "string" ? encoder.encode(data) : data.slice();
      const now = Date.now();
      parent.children.set(name, {
        kind: "file",
        content: bytes,
        mode: existing?.kind === "file" ? existing.mode : 0o100644,
        ctimeMs: existing?.kind === "file" ? existing.ctimeMs : now,
        mtimeMs: now,
      });
      parent.mtimeMs = now;
    },

    unlink: async (path: string): Promise<void> => {
      const norm = normalize(path);
      const parent = this.parentDir(norm, false);
      const name = norm.slice(norm.lastIndexOf("/") + 1);
      const node = parent.children.get(name);
      if (!node || node.kind === "dir")
        throw fsError("ENOENT", `ENOENT: no such file '${path}'`);
      parent.children.delete(name);
      parent.mtimeMs = Date.now();
    },

    readdir: async (path: string): Promise<string[]> => {
      const node = this.lookup(normalize(path), false);
      if (!node) throw fsError("ENOENT", `ENOENT: no such directory '${path}'`);
      if (node.kind !== "dir")
        throw fsError("ENOTDIR", `ENOTDIR: not a directory '${path}'`);
      return [...node.children.keys()];
    },

    mkdir: async (
      path: string,
      opts?: { recursive?: boolean },
    ): Promise<void> => {
      const norm = normalize(path);
      if (norm === "/") return;
      if (opts?.recursive) {
        let dir = this.root;
        for (const part of norm.slice(1).split("/")) {
          let child = dir.children.get(part);
          if (!child) {
            const now = Date.now();
            child = {
              kind: "dir",
              children: new Map(),
              mode: 0o040755,
              ctimeMs: now,
              mtimeMs: now,
            };
            dir.children.set(part, child);
          } else if (child.kind !== "dir") {
            throw fsError("ENOTDIR", `ENOTDIR: not a directory '${path}'`);
          }
          dir = child;
        }
        return;
      }
      const parent = this.parentDir(norm, false);
      const name = norm.slice(norm.lastIndexOf("/") + 1);
      if (parent.children.has(name))
        throw fsError("EEXIST", `EEXIST: already exists '${path}'`);
      const now = Date.now();
      parent.children.set(name, {
        kind: "dir",
        children: new Map(),
        mode: 0o040755,
        ctimeMs: now,
        mtimeMs: now,
      });
    },

    rmdir: async (path: string): Promise<void> => {
      const norm = normalize(path);
      if (norm === "/") throw fsError("EBUSY", "cannot remove root");
      const parent = this.parentDir(norm, false);
      const name = norm.slice(norm.lastIndexOf("/") + 1);
      const node = parent.children.get(name);
      if (!node) throw fsError("ENOENT", `ENOENT: no such directory '${path}'`);
      if (node.kind !== "dir")
        throw fsError("ENOTDIR", `ENOTDIR: not a directory '${path}'`);
      if (node.children.size > 0)
        throw fsError("ENOTEMPTY", `ENOTEMPTY: directory not empty '${path}'`);
      parent.children.delete(name);
    },

    stat: async (path: string): Promise<FsStat> => {
      const norm = normalize(path);
      const node = this.lookup(norm, true);
      if (!node) throw fsError("ENOENT", `ENOENT: no such file '${path}'`);
      return this.toStat(node);
    },

    lstat: async (path: string): Promise<FsStat> => {
      const node = this.lookup(normalize(path), false);
      if (!node) throw fsError("ENOENT", `ENOENT: no such file '${path}'`);
      return this.toStat(node);
    },

    readlink: async (path: string): Promise<string> => {
      const node = this.lookup(normalize(path), false);
      if (!node) throw fsError("ENOENT", `ENOENT: no such file '${path}'`);
      if (node.kind !== "symlink")
        throw fsError("EINVAL", `EINVAL: not a symlink '${path}'`);
      return node.target;
    },

    symlink: async (target: string, path: string): Promise<void> => {
      const norm = normalize(path);
      const parent = this.parentDir(norm, false);
      const name = norm.slice(norm.lastIndexOf("/") + 1);
      if (parent.children.has(name))
        throw fsError("EEXIST", `EEXIST: already exists '${path}'`);
      const now = Date.now();
      parent.children.set(name, {
        kind: "symlink",
        target,
        mode: 0o120777,
        ctimeMs: now,
        mtimeMs: now,
      });
    },

    chmod: async (path: string, mode: number): Promise<void> => {
      const node = this.lookup(normalize(path), false);
      if (!node) throw fsError("ENOENT", `ENOENT: no such file '${path}'`);
      node.mode = mode;
    },
  };

  private resolveLink(from: string, target: string): string {
    // Relative symlink targets resolve against the link's directory.
    if (target.startsWith("/")) return normalize(target);
    const dir = from.slice(0, from.lastIndexOf("/")) || "/";
    return normalize(dir + "/" + target);
  }

  /** Follow symlinks (up to a small depth) to the final node. */
  private lookup(norm: string, followLinks: boolean): FsNode | null {
    if (norm === "/") return this.root;
    const parts = norm.slice(1).split("/");
    let node: FsNode = this.root;
    let followed = 0;
    for (let i = 0; i < parts.length; i++) {
      if (node.kind !== "dir") return null;
      const child = node.children.get(parts[i]);
      if (!child) return null;
      node = child;
      if (followLinks && node.kind === "symlink") {
        if (++followed > 16)
          throw fsError("ELOOP", "too many levels of symbolic links");
        const rest = parts.slice(i + 1).join("/");
        const resolved = this.resolveLink(
          "/" + parts.slice(0, i + 1).join("/"),
          node.target,
        );
        const again = this.lookup(
          rest ? resolved + "/" + rest : resolved,
          true,
        );
        return again;
      }
    }
    return node;
  }

  private parentDir(norm: string, _follow: boolean): DirNode {
    const idx = norm.lastIndexOf("/");
    const parentPath = idx <= 0 ? "/" : norm.slice(0, idx);
    const parent = this.lookup(parentPath, true);
    if (!parent) throw fsError("ENOENT", `ENOENT: no such directory '${parentPath}'`);
    if (parent.kind !== "dir")
      throw fsError("ENOTDIR", `ENOTDIR: not a directory '${parentPath}'`);
    return parent;
  }

  private toStat(node: FsNode): FsStat {
    const size =
      node.kind === "file"
        ? node.content.length
        : node.kind === "symlink"
          ? encoder.encode(node.target).length
          : 0;
    const ino = this.inoCounter++;
    return {
      mode: node.mode,
      size,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      mtime: new Date(node.mtimeMs),
      ctime: new Date(node.ctimeMs),
      dev: 1,
      ino,
      uid: 0,
      gid: 0,
      isFile: () => node.kind === "file",
      isDirectory: () => node.kind === "dir",
      isSymbolicLink: () => node.kind === "symlink",
    };
  }
}
