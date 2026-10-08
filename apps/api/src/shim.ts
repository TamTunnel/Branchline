import type { Db } from "@branchline/core";
import type { BranchRow, MergeRow } from "./db.js";

/**
 * InMemoryDb — DEV/TEST ONLY, not for production.
 *
 * In-memory implementation of the `Db` (D1-subset) interface. It supports
 * exactly the SQL shapes used by src/db.ts, matched by normalized query
 * prefix:
 *
 *   SELECT * FROM branches WHERE name = ?
 *   SELECT * FROM branches ORDER BY created_at DESC
 *   INSERT INTO branches (name, intent, agent_id, touches, base_sha, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
 *   UPDATE branches SET status = ? WHERE name = ?
 *   INSERT INTO merges (branch, base, target, status) VALUES (?, ?, ?, ?) RETURNING id
 *   SELECT * FROM merges ORDER BY id DESC LIMIT ?
 *   UPDATE merges SET <col> = ?, ... WHERE id = ?
 *
 * DDL (CREATE TABLE / ALTER TABLE / CREATE INDEX) is accepted as a no-op so
 * schema files can be "applied" against it. Any other query throws.
 * Dependency-free.
 */

function normalize(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryDb implements Db {
  private branches = new Map<string, BranchRow>();
  private merges = new Map<number, MergeRow>();
  private nextMergeId = 1;

  prepare(query: string) {
    const q = normalize(query);
    const self = this;
    return {
      bind(...params: unknown[]) {
        return {
          all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return Promise.resolve({ results: self.select<T>(q, params) });
          },
          first<T = Record<string, unknown>>(): Promise<T | null> {
            const results = self.select<T>(q, params);
            return Promise.resolve(results[0] ?? null);
          },
          run(): Promise<{ success: boolean }> {
            self.write(q, params);
            return Promise.resolve({ success: true });
          },
        };
      },
    };
  }

  /** Handles SELECTs and INSERT ... RETURNING (used via first()). */
  private select<T>(q: string, params: unknown[]): T[] {
    if (q === "select * from branches where name = ?") {
      const row = this.branches.get(String(params[0]));
      return (row ? [row] : []) as unknown as T[];
    }
    if (q === "select * from branches order by created_at desc") {
      return [...this.branches.values()]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((r) => ({ ...r })) as unknown as T[];
    }
    if (
      q ===
      "insert into branches (name, intent, agent_id, touches, base_sha, status, created_at) values (?, ?, ?, ?, ?, ?, ?)"
    ) {
      const [name, intent, agent_id, touches, base_sha, status, created_at] =
        params as string[];
      if (this.branches.has(name)) {
        throw new Error(`InMemoryDb: duplicate branch primary key: ${name}`);
      }
      this.branches.set(name, {
        name,
        intent,
        agent_id,
        touches,
        base_sha,
        status,
        created_at,
      });
      return [];
    }
    if (
      q ===
      "insert into merges (branch, base, target, status) values (?, ?, ?, ?) returning id"
    ) {
      const id = this.nextMergeId++;
      const [branch, base, target, status] = params as string[];
      this.merges.set(id, {
        id,
        branch,
        base,
        target,
        tier: null,
        status,
        artifact: null,
        merge_sha: null,
        created_at: nowIso(),
      });
      return [{ id }] as unknown as T[];
    }
    if (q === "select * from merges order by id desc limit ?") {
      const limit = Number(params[0]);
      return [...this.merges.values()]
        .sort((a, b) => b.id - a.id)
        .slice(0, Number.isFinite(limit) ? limit : 50)
        .map((r) => ({ ...r })) as unknown as T[];
    }
    throw new Error(`InMemoryDb: unsupported query: ${q}`);
  }

  /** Handles INSERT (non-RETURNING), UPDATE, and DDL no-ops. */
  private write(q: string, params: unknown[]): void {
    if (
      q.startsWith("create table") ||
      q.startsWith("alter table") ||
      q.startsWith("create index")
    ) {
      return; // DDL no-op: tables are implicit in memory
    }
    if (q === "update branches set status = ? where name = ?") {
      const [status, name] = params as [string, string];
      const row = this.branches.get(name);
      if (row) row.status = status;
      return;
    }
    const mergeUpdate = q.match(/^update merges set (.+) where id = \?$/);
    if (mergeUpdate) {
      const cols = mergeUpdate[1]
        .split(",")
        .map((part) => part.trim().split(" ")[0]);
      const id = Number(params[params.length - 1]);
      const row = this.merges.get(id);
      if (!row) return;
      cols.forEach((col, i) => {
        (row as unknown as Record<string, unknown>)[col] = params[i];
      });
      return;
    }
    // INSERT INTO branches without RETURNING goes through run()
    if (
      q ===
      "insert into branches (name, intent, agent_id, touches, base_sha, status, created_at) values (?, ?, ?, ?, ?, ?, ?)"
    ) {
      this.select(q, params);
      return;
    }
    throw new Error(`InMemoryDb: unsupported query: ${q}`);
  }
}
