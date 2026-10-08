/**
 * Branchline core: deterministic three-way merge over the frozen contracts.
 *
 * Pure functions only — no I/O, no network. Conflict markers (`<<<<<<<`)
 * are NEVER emitted: real conflicts come back as structured data and the
 * API layer turns them into ConflictArtifact JSON.
 */
import { diff3Merge } from "node-diff3";
import { globMatch } from "./diff.js";
import type {
  ConflictArtifact,
  IntentManifest,
  MergeDecision,
  MergeStatus,
  MergeTier,
} from "./types.js";
import type { FileMap } from "./diff.js";

function contentOf(map: FileMap, path: string): string | null {
  const v = map.get(path);
  return v === undefined ? null : v;
}

/** Sort ranges and merge overlapping or adjacent intervals (tuple copies). */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.map((r) => [r[0], r[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Three-way merge of a single file. Null = absent.
 *
 * Nulls are resolved structurally first (identical sides, one side
 * unchanged, add/add with equal content). Genuine conflicts return
 * `{ok:false, overlapping}` with best-effort base line ranges taken from
 * the conflict regions node-diff3 reports — never raw conflict markers.
 */
export function threeWayMergeFile(
  base: string | null,
  ours: string | null,
  theirs: string | null,
): { ok: true; merged: string } | { ok: false; overlapping: Array<[number, number]> } {
  if (ours === theirs) return { ok: true, merged: ours ?? "" };
  if (base === ours) return { ok: true, merged: theirs ?? "" };
  if (base === theirs) return { ok: true, merged: ours ?? "" };
  if (base === null) {
    // Add/add with different content (all other null combos resolved above).
    return { ok: false, overlapping: [[1, 1]] };
  }

  // Split without dropping the trailing "" so join("\n") round-trips exactly.
  const oLines = base.split("\n");
  const aLines = (ours ?? "").split("\n");
  const bLines = (theirs ?? "").split("\n");

  const regions = diff3Merge(aLines, oLines, bLines, { excludeFalseConflicts: true });

  const merged: string[] = [];
  const overlapping: Array<[number, number]> = [];
  let conflicted = false;
  for (const region of regions) {
    if (region.ok) {
      merged.push(...region.ok);
    } else if (region.conflict) {
      conflicted = true;
      const c = region.conflict;
      // oIndex is 0-based into base; empty o = pure insertion at that point.
      const start = c.oIndex + 1;
      const end = c.o.length === 0 ? start : c.oIndex + c.o.length;
      overlapping.push([start, end]);
    }
  }

  if (!conflicted) return { ok: true, merged: merged.join("\n") };
  if (overlapping.length === 0) {
    // Should not happen (conflict regions always carry o-ranges), but stay total.
    overlapping.push([1, Math.max(1, oLines.length)]);
  }
  return { ok: false, overlapping: mergeRanges(overlapping) };
}

/** Arguments for decideMerge / mergedFileContents. */
export interface DecideMergeArgs {
  baseFiles: FileMap;
  oursFiles: FileMap;
  theirsFiles: FileMap;
  oursManifest: IntentManifest;
  theirsManifest: IntentManifest;
  /** Declared touch globs for each side (usually the manifests' touches). */
  oursTouches: string[];
  theirsTouches: string[];
}

function touchedBy(globs: string[], file: string): boolean {
  return globs.some((g) => globMatch(g, file));
}

interface MergeComputation {
  tier: MergeTier;
  status: MergeStatus;
  mergedFiles: string[];
  contents: Record<string, string | null>;
  conflicts: ConflictArtifact[];
}

/**
 * Decide the merge tier without touching the filesystem. Pure: the API
 * layer applies the returned decision via GitBackend.applyMerge.
 *
 * - Tier 1: the two sides' touched-file sets are disjoint → clean merge,
 *   merged_files = every file changed by either side.
 * - Tier 2/3: for each file touched by both sides, attempt threeWayMergeFile
 *   (it can succeed even when changed line ranges overlap). Successes land
 *   in merged_files; failures become ConflictArtifact entries.
 * - Tier 3 iff any conflicts: status "needs-resolution", merged_files holds
 *   only the clean files.
 *
 * A file changed outside both sides' declared touch globs counts as touched
 * by both sides that actually changed it (conservative: undeclared changes
 * are never silently auto-merged when the other side changed the file too).
 * Crucially, declared globs only ever *narrow* attribution: a side is never
 * marked as touching a file it did not actually change, no matter how broad
 * its declared globs are.
 */
function computeMerge(args: DecideMergeArgs): MergeComputation {
  const { baseFiles, oursFiles, theirsFiles, oursManifest, theirsManifest, oursTouches, theirsTouches } = args;

  const allPaths = new Set<string>();
  for (const m of [baseFiles, oursFiles, theirsFiles]) {
    for (const k of m.keys()) allPaths.add(k);
  }

  const oursChanged = new Set<string>();
  const theirsChanged = new Set<string>();
  for (const p of allPaths) {
    if (contentOf(baseFiles, p) !== contentOf(oursFiles, p)) oursChanged.add(p);
    if (contentOf(baseFiles, p) !== contentOf(theirsFiles, p)) theirsChanged.add(p);
  }
  const changedFiles = [...new Set([...oursChanged, ...theirsChanged])].sort();

  const oursTouched = new Set<string>();
  const theirsTouched = new Set<string>();
  for (const f of changedFiles) {
    const mo = touchedBy(oursTouches, f);
    const mt = touchedBy(theirsTouches, f);
    const undeclared = !mo && !mt;
    // Attribution = actual change ∩ (declared match ∪ neither-declared).
    // Declared globs narrow attribution; they never widen it to files the
    // side did not change.
    if (oursChanged.has(f) && (mo || undeclared)) oursTouched.add(f);
    if (theirsChanged.has(f) && (mt || undeclared)) theirsTouched.add(f);
  }
  const overlap = new Set([...oursTouched].filter((f) => theirsTouched.has(f)));

  const contents: Record<string, string | null> = {};
  const conflicts: ConflictArtifact[] = [];
  const clean: string[] = [];

  const singleSideContent = (f: string): string | null =>
    oursChanged.has(f) ? contentOf(oursFiles, f) : contentOf(theirsFiles, f);

  if (overlap.size === 0) {
    for (const f of changedFiles) contents[f] = singleSideContent(f);
    return { tier: 1, status: "merged", mergedFiles: changedFiles, contents, conflicts };
  }

  for (const f of changedFiles) {
    if (!overlap.has(f)) {
      contents[f] = singleSideContent(f);
      clean.push(f);
      continue;
    }
    const base = contentOf(baseFiles, f);
    const ours = contentOf(oursFiles, f);
    const theirs = contentOf(theirsFiles, f);
    const r = threeWayMergeFile(base, ours, theirs);
    if (r.ok) {
      contents[f] = r.merged;
      clean.push(f);
    } else {
      conflicts.push({
        file: f,
        base,
        ours,
        theirs,
        ours_manifest: oursManifest,
        theirs_manifest: theirsManifest,
        overlapping_ranges: r.overlapping,
      });
    }
  }

  if (conflicts.length > 0) {
    return { tier: 3, status: "needs-resolution", mergedFiles: clean, contents, conflicts };
  }
  return { tier: 2, status: "merged", mergedFiles: clean, contents, conflicts };
}

export function decideMerge(args: DecideMergeArgs): Omit<MergeDecision, "merge_sha"> {
  const c = computeMerge(args);
  return { tier: c.tier, status: c.status, merged_files: c.mergedFiles, conflicts: c.conflicts };
}

/**
 * Merged file contents for the API layer to pass to GitBackend.applyMerge
 * (path -> content; null deletes). Covers exactly the files listed in the
 * decision's `merged_files`: tiers 1–2 return every changed file, tier 3
 * returns only the cleanly merged subset. Deterministic and pure — it
 * recomputes the same merge decideMerge ran.
 */
export function mergedFileContents(args: DecideMergeArgs): Record<string, string | null> {
  return computeMerge(args).contents;
}
