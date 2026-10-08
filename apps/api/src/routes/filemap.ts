import type { FileMap, GitBackend } from "@branchline/core";

/** Build a path -> content FileMap for `ref` via listFiles + readFile. */
export async function readFileMap(
  backend: GitBackend,
  ref: string,
): Promise<FileMap> {
  const paths = await backend.listFiles(ref);
  const entries = await Promise.all(
    paths.map(async (p) => [p, await backend.readFile(ref, p)] as const),
  );
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
