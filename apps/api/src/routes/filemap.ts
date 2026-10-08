import type { FileMap, GitBackend } from "@branchline/core";

/** Maximum files readFileMap will materialize for one ref. */
export const MAX_FILES_PER_REF = 2000;
/** Max concurrent readFile calls (one Artifacts RPC each in production). */
const READ_CONCURRENCY = 25;

/** Thrown when a ref holds more files than readFileMap will read. */
export class TooManyFilesError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(
      `ref has ${count} files, over the ${MAX_FILES_PER_REF}-file read limit; ` +
        `narrow the repo or raise the limit`,
    );
    this.name = "TooManyFilesError";
    this.count = count;
  }
}

/**
 * Build a path -> content FileMap for `ref` via listFiles + readFile.
 * Reads are bounded (READ_CONCURRENCY in flight) so a large repo cannot
 * OOM the Worker or throttle the Artifacts binding; refs over
 * MAX_FILES_PER_REF throw TooManyFilesError (the diff route maps it to 413).
 */
export async function readFileMap(
  backend: GitBackend,
  ref: string,
): Promise<FileMap> {
  const paths = await backend.listFiles(ref);
  if (paths.length > MAX_FILES_PER_REF) {
    throw new TooManyFilesError(paths.length);
  }
  const entries: Array<readonly [string, string | null]> = [];
  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    const chunk = paths.slice(i, i + READ_CONCURRENCY);
    const got = await Promise.all(
      chunk.map(async (p) => [p, await backend.readFile(ref, p)] as const),
    );
    entries.push(...got);
  }
  return new Map(entries);
}

/** Paths whose content differs between two FileMaps (adds/deletes included). */
export function changedFileSet(a: FileMap, b: FileMap): Set<string> {
  const out = new Set<string>();
  for (const [path, content] of a) {
    if (!b.has(path) || b.get(path) !== content) out.add(path);
  }
  for (const path of b.keys()) {
    if (!a.has(path)) out.add(path);
  }
  return out;
}
