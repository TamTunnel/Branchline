import type { Db } from "@branchline/core";

/** Row shape of the `branches` table. `touches` is a JSON array of glob patterns. */
export interface BranchRow {
  name: string;
  intent: string;
  agent_id: string;
  touches: string;
  base_sha: string;
  status: string;
  created_at: string;
}

/** Row shape of the `merges` table (includes 002_merge_sha.sql). */
export interface MergeRow {
  id: number;
  branch: string;
  base: string;
  target: string;
  tier: 1 | 2 | 3 | null;
  status: string;
  artifact: string | null;
  merge_sha: string | null;
  created_at: string;
}

export async function getBranch(db: Db, name: string): Promise<BranchRow | null> {
  return db
    .prepare("SELECT * FROM branches WHERE name = ?")
    .bind(name)
    .first<BranchRow>();
}

export async function listBranches(db: Db): Promise<BranchRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM branches ORDER BY created_at DESC")
    .bind()
    .all<BranchRow>();
  return results;
}

export async function insertBranch(db: Db, row: BranchRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO branches (name, intent, agent_id, touches, base_sha, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.name,
      row.intent,
      row.agent_id,
      row.touches,
      row.base_sha,
      row.status,
      row.created_at,
    )
    .run();
}

export async function updateBranchStatus(
  db: Db,
  name: string,
  status: string,
): Promise<void> {
  await db
    .prepare("UPDATE branches SET status = ? WHERE name = ?")
    .bind(status, name)
    .run();
}

/** Insert a merge job row (status='queued'). Returns the new row id. */
export async function enqueueMerge(
  db: Db,
  input: { branch: string; base: string; target: string },
): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO merges (branch, base, target, status) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(input.branch, input.base, input.target, "queued")
    .first<{ id: number }>();
  if (!row) throw new Error("enqueueMerge: failed to insert merge row");
  return row.id;
}

export async function listMerges(db: Db, limit = 50): Promise<MergeRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM merges ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<MergeRow>();
  return results;
}

export type MergePatch = Partial<
  Pick<MergeRow, "tier" | "status" | "artifact" | "merge_sha">
>;

export async function updateMerge(
  db: Db,
  id: number,
  patch: MergePatch,
): Promise<void> {
  const keys = Object.keys(patch) as (keyof MergePatch)[];
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  const params = keys.map((k) => patch[k] ?? null);
  await db
    .prepare(`UPDATE merges SET ${set} WHERE id = ?`)
    .bind(...params, id)
    .run();
}
