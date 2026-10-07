export * from "./types.js";
export * from "./manifest.js";
export * from "./diff.js";
export * from "./merge.js";
//
// Planned pure-function surface (do not change signatures without updating
// apps/api and apps/cli implementers):
//
//   export type FileMap = Map<string, string | null>; // path -> content (null = absent)
//   export function buildFileOps(base: FileMap, head: FileMap): FileOp[];
//   export function changedRanges(base: string, head: string): Array<[number, number]>>; // 1-based base line ranges
//   export function rangesOverlap(a: Array<[number,number]>, b: Array<[number,number]>): boolean;
//   export function threeWayMergeFile(base: string|null, ours: string|null, theirs: string|null):
//     { ok: true; merged: string } | { ok: false; overlapping: Array<[number, number]> };
//   export function decideMerge(args: {
//     baseFiles: FileMap; oursFiles: FileMap; theirsFiles: FileMap;
//     oursManifest: IntentManifest; theirsManifest: IntentManifest;
//     oursTouches: string[]; theirsTouches: string[];
//   }): Omit<MergeDecision, "merge_sha">;
