import { describe, it, expect } from "vitest";
import {
  parseManifest,
  buildFileOps,
  changedRanges,
  rangesOverlap,
  globMatch,
  threeWayMergeFile,
  decideMerge,
  type FileMap,
  type IntentManifest,
} from "@branchline/core";

function fm(entries: Record<string, string | null>): FileMap {
  return new Map(Object.entries(entries));
}

function testManifest(over: Partial<IntentManifest> = {}): IntentManifest {
  return {
    intent: "add oauth login",
    agent_id: "agent-1",
    touches: ["src/auth/**"],
    base: "abc123",
    status: "open",
    created_at: new Date().toISOString(),
    ...over,
  };
}

const MARKER = "<<<<<<<";

// ---------------------------------------------------------------------------
// manifest validation
// ---------------------------------------------------------------------------
describe("parseManifest", () => {
  it("accepts a good manifest and defaults status to open", () => {
    const { status, ...input } = testManifest();
    const m = parseManifest(input);
    expect(m.status).toBe("open");
    expect(m.intent).toBe("add oauth login");
    expect(m.touches).toEqual(["src/auth/**"]);
  });

  it("rejects an empty intent", () => {
    expect(() => parseManifest(testManifest({ intent: "" }))).toThrow();
  });

  it("rejects a non-SHA base", () => {
    expect(() => parseManifest(testManifest({ base: "xyz-not-a-sha!" }))).toThrow();
  });

  it("rejects empty touches", () => {
    expect(() => parseManifest(testManifest({ touches: [] }))).toThrow();
  });

  it("rejects a non-datetime created_at", () => {
    expect(() =>
      parseManifest(testManifest({ created_at: "not-a-date" })),
    ).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      parseManifest(testManifest({ status: "in-progress" as never })),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildFileOps
// ---------------------------------------------------------------------------
describe("buildFileOps", () => {
  it("reports an added file with 1-based hunk line numbers", () => {
    const ops = buildFileOps(fm({}), fm({ "new.txt": "a\nb\n" }));
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("added");
    expect(ops[0].hunks).toEqual([
      { type: "add", lines: [1, 2], text: ["a", "b"] },
    ]);
    expect(ops[0].summary).toContain("+2");
  });

  it("reports a deleted file", () => {
    const ops = buildFileOps(fm({ "old.txt": "a\nb\n" }), fm({}));
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("deleted");
    expect(ops[0].hunks).toEqual([
      { type: "del", lines: [1, 2], text: ["a", "b"] },
    ]);
  });

  it("emits separate add/del hunks with correct 1-based line numbers", () => {
    const base = "l1\nl2\nl3\nl4\nl5\n";
    const head = "l1\nL2\nl3\nl4\nL5\n";
    const ops = buildFileOps(fm({ "f.txt": base }), fm({ "f.txt": head }));
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("modified");
    // del hunks carry base coordinates, add hunks head coordinates
    expect(ops[0].hunks).toEqual([
      { type: "del", lines: [2, 2], text: ["l2"] },
      { type: "add", lines: [2, 2], text: ["L2"] },
      { type: "del", lines: [5, 5], text: ["l5"] },
      { type: "add", lines: [5, 5], text: ["L5"] },
    ]);
  });

  it("sorts ops by path", () => {
    const ops = buildFileOps(fm({}), fm({ "b.txt": "x\n", "a.txt": "y\n" }));
    expect(ops.map((o) => o.file)).toEqual(["a.txt", "b.txt"]);
  });

  it("marks binary files without hunks", () => {
    const ops = buildFileOps(fm({ "b.bin": "aaa" }), fm({ "b.bin": "a\0b" }));
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("modified");
    expect(ops[0].hunks).toEqual([]);
    expect(ops[0].summary).toBe("binary file");
  });

  it("truncates giant hunks and notes it in the summary", () => {
    const big = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const ops = buildFileOps(fm({}), fm({ "big.txt": big }));
    expect(ops[0].hunks[0].text).toHaveLength(200);
    expect(ops[0].hunks[0].lines).toEqual([1, 250]);
    expect(ops[0].summary).toContain("truncated");
  });

  it("emits no op for identical content", () => {
    expect(buildFileOps(fm({ "a.txt": "x\n" }), fm({ "a.txt": "x\n" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// changedRanges / rangesOverlap
// ---------------------------------------------------------------------------
describe("changedRanges", () => {
  it("reports modified base line ranges (adjacent ranges merge)", () => {
    // removed run -> [2,3]; added run -> insertion point [4,4]; the two are
    // adjacent, so the documented merged/sorted contract yields [2,4].
    expect(changedRanges("a\nb\nc\n", "a\nB\nC\n")).toEqual([[2, 4]]);
  });

  it("reports an insertion as a zero-width point range", () => {
    expect(changedRanges("a\nc\n", "a\nb\nc\n")).toEqual([[2, 2]]);
  });

  it("reports a deletion range", () => {
    expect(changedRanges("a\nb\nc\n", "a\nc\n")).toEqual([[2, 2]]);
  });

  it("returns [] for identical files", () => {
    expect(changedRanges("a\n", "a\n")).toEqual([]);
  });
});

describe("rangesOverlap", () => {
  it("detects touching intervals as overlapping", () => {
    expect(rangesOverlap([[1, 2]], [[2, 3]])).toBe(true);
  });

  it("returns false for disjoint intervals", () => {
    expect(rangesOverlap([[1, 1]], [[2, 2]])).toBe(false);
  });

  it("detects a point range inside a wider range", () => {
    expect(rangesOverlap([[5, 5]], [[1, 10]])).toBe(true);
  });

  it("returns false when either side is empty", () => {
    expect(rangesOverlap([], [[1, 2]])).toBe(false);
    expect(rangesOverlap([[1, 2]], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// globMatch
// ---------------------------------------------------------------------------
describe("globMatch", () => {
  it("supports ** crossing segment boundaries", () => {
    expect(globMatch("src/**", "src")).toBe(true);
    expect(globMatch("src/**", "src/a.ts")).toBe(true);
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("src/**", "other/a.ts")).toBe(false);
  });

  it("keeps * within a single segment", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/b.ts")).toBe(false);
  });

  it("lets a leading ** match the basename alone", () => {
    expect(globMatch("**/login.ts", "login.ts")).toBe(true);
    expect(globMatch("**/login.ts", "a/b/login.ts")).toBe(true);
  });

  it("supports ? for a single char", () => {
    expect(globMatch("src/?.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/?.ts", "src/ab.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// threeWayMergeFile
// ---------------------------------------------------------------------------
describe("threeWayMergeFile", () => {
  it("merges disjoint edits cleanly", () => {
    // changes must be separated by context: adjacent-line edits on both
    // sides form a single diff hunk, which (like git) counts as a conflict.
    const r = threeWayMergeFile(
      "a\nb\nc\nd\ne\n",
      "a\nB\nc\nd\ne\n",
      "a\nb\nc\nd\nE\n",
    );
    expect(r).toEqual({ ok: true, merged: "a\nB\nc\nd\nE\n" });
  });

  it("reports adjacent-line edits on both sides as a conflict", () => {
    const r = threeWayMergeFile("a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n");
    expect(r.ok).toBe(false);
  });

  it("returns either side when the other is unchanged", () => {
    expect(threeWayMergeFile("a\n", "a\n", "b\n")).toEqual({
      ok: true,
      merged: "b\n",
    });
    expect(threeWayMergeFile("a\n", "b\n", "a\n")).toEqual({
      ok: true,
      merged: "b\n",
    });
  });

  it("merges identical sides", () => {
    expect(threeWayMergeFile("a\n", "b\n", "b\n")).toEqual({
      ok: true,
      merged: "b\n",
    });
  });

  it("reports add/add with different content as a conflict", () => {
    const r = threeWayMergeFile(null, "x\n", "y\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.overlapping).toEqual([[1, 1]]);
  });

  it("merges add/add with identical content", () => {
    expect(threeWayMergeFile(null, "x\n", "x\n")).toEqual({
      ok: true,
      merged: "x\n",
    });
  });

  it("reports delete/modify as a conflict", () => {
    const r = threeWayMergeFile("a\nb\n", null, "a\nB\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.overlapping.length).toBeGreaterThan(0);
  });

  it("never emits conflict markers", () => {
    const cases: Array<[string | null, string | null, string | null]> = [
      [null, "x\n", "y\n"],
      ["a\nb\n", null, "a\nB\n"],
      ["l1\nl2\nl3\n", "l1\nX\nl3\n", "l1\nY\nl3\n"],
    ];
    for (const [b, o, t] of cases) {
      const r = threeWayMergeFile(b, o, t);
      expect(JSON.stringify(r)).not.toContain(MARKER);
      if (r.ok) expect(r.merged).not.toContain(MARKER);
    }
  });
});

// ---------------------------------------------------------------------------
// decideMerge tiers
// ---------------------------------------------------------------------------
describe("decideMerge", () => {
  const m1 = testManifest({ agent_id: "agent-1", touches: ["a.txt"] });
  const m2 = testManifest({ agent_id: "agent-2", touches: ["b.txt"] });

  it("tier 1: disjoint touched files merge cleanly", () => {
    const d = decideMerge({
      baseFiles: fm({ "a.txt": "a", "b.txt": "b" }),
      oursFiles: fm({ "a.txt": "A", "b.txt": "b" }),
      theirsFiles: fm({ "a.txt": "a", "b.txt": "B" }),
      oursManifest: m1,
      theirsManifest: m2,
      oursTouches: ["a.txt"],
      theirsTouches: ["b.txt"],
    });
    expect(d.tier).toBe(1);
    expect(d.status).toBe("merged");
    expect(d.merged_files).toEqual(["a.txt", "b.txt"]);
    expect(d.conflicts).toEqual([]);
  });

  it("tier 1: broad declared globs do not widen attribution to unchanged files", () => {
    // Regression: declared `touches` globs must narrow attribution, never
    // widen it. agent-1 declares src/auth/** but only changed login.ts;
    // oauth.ts was changed by the other side alone -> still tier 1.
    const d = decideMerge({
      baseFiles: fm({ "src/auth/login.ts": "a", "src/auth/oauth.ts": "b" }),
      oursFiles: fm({ "src/auth/login.ts": "A", "src/auth/oauth.ts": "b" }),
      theirsFiles: fm({ "src/auth/login.ts": "a", "src/auth/oauth.ts": "B" }),
      oursManifest: testManifest({ agent_id: "agent-1", touches: ["src/auth/**"] }),
      theirsManifest: testManifest({ agent_id: "agent-2", touches: ["src/auth/**"] }),
      oursTouches: ["src/auth/**"],
      theirsTouches: ["src/auth/oauth.ts"],
    });
    expect(d.tier).toBe(1);
    expect(d.status).toBe("merged");
  });

  it("tier 2: same file, non-overlapping hunks merge cleanly", () => {
    const base = "1\n2\n3\n4\n5\n6\n";
    const d = decideMerge({
      baseFiles: fm({ "f.txt": base }),
      oursFiles: fm({ "f.txt": "one\n2\n3\n4\n5\n6\n" }),
      theirsFiles: fm({ "f.txt": "1\n2\n3\n4\n5\nsix\n" }),
      oursManifest: m1,
      theirsManifest: m2,
      oursTouches: ["f.txt"],
      theirsTouches: ["f.txt"],
    });
    expect(d.tier).toBe(2);
    expect(d.status).toBe("merged");
    expect(d.conflicts).toEqual([]);
    expect(d.merged_files).toEqual(["f.txt"]);
  });

  it("tier 3: same-line conflict becomes a structured artifact, no markers", () => {
    const base = "l1\nl2\nl3\n";
    const d = decideMerge({
      baseFiles: fm({ "f.txt": base }),
      oursFiles: fm({ "f.txt": "l1\nOURS\nl3\n" }),
      theirsFiles: fm({ "f.txt": "l1\nTHEIRS\nl3\n" }),
      oursManifest: m1,
      theirsManifest: m2,
      oursTouches: ["f.txt"],
      theirsTouches: ["f.txt"],
    });
    expect(d.tier).toBe(3);
    expect(d.status).toBe("needs-resolution");
    expect(d.conflicts).toHaveLength(1);
    const c = d.conflicts[0];
    expect(c.file).toBe("f.txt");
    expect(c.base).toBe(base);
    expect(c.ours).toContain("OURS");
    expect(c.theirs).toContain("THEIRS");
    expect(c.ours_manifest.agent_id).toBe("agent-1");
    expect(c.theirs_manifest.agent_id).toBe("agent-2");
    expect(c.overlapping_ranges.length).toBeGreaterThan(0);
    // the conflicted file is excluded from the clean set
    expect(d.merged_files).not.toContain("f.txt");
    // no raw conflict markers anywhere in the decision
    expect(JSON.stringify(d)).not.toContain(MARKER);
  });

  it("treats a file changed by both sides outside declared globs as shared (conservative)", () => {
    // x.txt was changed by BOTH sides but matches neither side's declared
    // globs: it must not be silently auto-merged at tier 1. Same-line edit
    // -> structured tier-3 conflict.
    const d = decideMerge({
      baseFiles: fm({ "x.txt": "1" }),
      oursFiles: fm({ "x.txt": "2" }),
      theirsFiles: fm({ "x.txt": "3" }),
      oursManifest: m1,
      theirsManifest: m2,
      oursTouches: ["zzz/**"],
      theirsTouches: ["yyy/**"],
    });
    expect(d.tier).toBe(3);
    expect(d.status).toBe("needs-resolution");
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0].file).toBe("x.txt");
  });

  it("one-sided changes outside declared globs still merge at tier 1", () => {
    // x.txt changed only by ours, y.txt only by theirs; neither matches any
    // declared glob. No file was changed by both sides, so there is nothing
    // to conflict over -> tier 1.
    const d = decideMerge({
      baseFiles: fm({ "x.txt": "1", "y.txt": "1" }),
      oursFiles: fm({ "x.txt": "2", "y.txt": "1" }),
      theirsFiles: fm({ "x.txt": "1", "y.txt": "2" }),
      oursManifest: m1,
      theirsManifest: m2,
      oursTouches: ["zzz/**"],
      theirsTouches: ["yyy/**"],
    });
    expect(d.tier).toBe(1);
    expect(d.status).toBe("merged");
  });
});
