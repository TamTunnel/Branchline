/**
 * Branchline core: agent-readable diffs and line-range helpers.
 *
 * Pure functions only — no I/O, no network.
 */
import { diffLines } from "diff";
import type { DiffHunk, FileOp, FileStatus } from "./types.js";

/** path -> content; null (or missing key) = absent. */
export type FileMap = Map<string, string | null>;

const MAX_HUNK_LINES = 200;

/** Split into lines, dropping the single trailing "" from a trailing newline. */
function linesOf(s: string): string[] {
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function contentOf(map: FileMap, path: string): string | null {
  const v = map.get(path);
  return v === undefined ? null : v;
}

/**
 * Per-file diff operations between two file maps, sorted by path.
 * Uses diffLines; add/del parts are grouped into one hunk per type
 * (emitted in encounter order, never paired into unified hunks).
 */
export function buildFileOps(base: FileMap, head: FileMap): FileOp[] {
  const paths = new Set<string>();
  for (const k of base.keys()) paths.add(k);
  for (const k of head.keys()) paths.add(k);

  const ops: FileOp[] = [];
  for (const file of [...paths].sort()) {
    const b = contentOf(base, file);
    const h = contentOf(head, file);
    if (b === h) continue;

    const status: FileStatus = b === null ? "added" : h === null ? "deleted" : "modified";

    if ((b !== null && b.includes("\0")) || (h !== null && h.includes("\0"))) {
      ops.push({ file, status, hunks: [], summary: "binary file" });
      continue;
    }

    const hunks: DiffHunk[] = [];
    let added = 0;
    let removed = 0;

    if (status === "added") {
      const lines = linesOf(h as string);
      added = lines.length;
      if (lines.length > 0) hunks.push({ type: "add", lines: [1, lines.length], text: lines });
    } else if (status === "deleted") {
      const lines = linesOf(b as string);
      removed = lines.length;
      if (lines.length > 0) hunks.push({ type: "del", lines: [1, lines.length], text: lines });
    } else {
      let baseCursor = 1;
      let headCursor = 1;
      let openAdd: DiffHunk | null = null;
      let openDel: DiffHunk | null = null;
      for (const part of diffLines(b as string, h as string)) {
        const lines = linesOf(part.value);
        const n = lines.length;
        if (n === 0) continue;
        if (part.added) {
          added += n;
          if (openAdd) {
            openAdd.lines[1] += n;
            openAdd.text.push(...lines);
          } else {
            openAdd = { type: "add", lines: [headCursor, headCursor + n - 1], text: [...lines] };
            hunks.push(openAdd);
          }
          openDel = null;
          headCursor += n;
        } else if (part.removed) {
          removed += n;
          if (openDel) {
            openDel.lines[1] += n;
            openDel.text.push(...lines);
          } else {
            openDel = { type: "del", lines: [baseCursor, baseCursor + n - 1], text: [...lines] };
            hunks.push(openDel);
          }
          openAdd = null;
          baseCursor += n;
        } else {
          openAdd = null;
          openDel = null;
          baseCursor += n;
          headCursor += n;
        }
      }
    }

    let truncated = false;
    for (const hk of hunks) {
      if (hk.text.length > MAX_HUNK_LINES) {
        hk.text = hk.text.slice(0, MAX_HUNK_LINES);
        truncated = true;
      }
    }

    let summary = `+${added} -${removed} in ${file}`;
    if (truncated) summary += ` · hunk truncated at ${MAX_HUNK_LINES} lines`;
    ops.push({ file, status, hunks, summary });
  }
  return ops;
}

/** Sort ranges and merge overlapping or adjacent intervals. */
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
 * 1-based line ranges in BASE coordinates touched by base->head.
 * A removed run of N lines at cursor C yields [C, C+N-1]; an added run
 * yields the zero-width insertion point [C, C]. Returns merged/sorted ranges.
 */
export function changedRanges(base: string, head: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = 1; // next base line number
  for (const part of diffLines(base, head)) {
    const n = linesOf(part.value).length;
    if (n === 0) continue;
    if (part.removed) {
      ranges.push([cursor, cursor + n - 1]);
      cursor += n;
    } else if (part.added) {
      ranges.push([cursor, cursor]); // insertion point; base cursor does not advance
    } else {
      cursor += n;
    }
  }
  return mergeRanges(ranges);
}

/**
 * True if any interval pair overlaps. Point ranges [x,x] overlap [y,z]
 * iff y <= x <= z.
 */
export function rangesOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      if (a0 <= b1 && b0 <= a1) return true;
    }
  }
  return false;
}

function segToRegExp(seg: string): string {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  const segs = glob.split("/");
  let out = "^";
  let slashPending = false; // a literal segment needs a "/" before it
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      // "**" crosses "/"; matches zero or more whole path segments.
      out += last ? (slashPending ? "(?:/.*)?" : ".*") : slashPending ? "/(?:.*/)?" : "(?:.*/)?";
      slashPending = false;
    } else {
      if (slashPending) out += "/";
      out += segToRegExp(seg);
      slashPending = true;
    }
  }
  return new RegExp(out + "$");
}

/**
 * Tiny glob matcher supporting `*` (within a segment), `**` (crosses `/`),
 * and `?` (single char within a segment). E.g. "src/**" matches "src",
 * "src/a.ts" and "src/a/b.ts"; a leading "**" segment also matches the
 * basename alone ("foo" as well as "a/b/foo").
 */
export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}
