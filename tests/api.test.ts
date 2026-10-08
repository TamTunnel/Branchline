/**
 * Branchline API integration tests.
 *
 * Drives the real Hono app via `createApp(env)` + `app.request()` (no
 * network, no Workers runtime) against a throwaway git repo and the
 * InMemoryDb D1 shim.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../apps/api/src/index.js";
import worker from "../apps/api/src/index.js";
import { InMemoryDb } from "../apps/api/src/shim.js";

const MARKER = "<<<<<<<";

let tmp: string;
let base0: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" }).trim();
}

function write(rel: string, content: string): void {
  const abs = join(tmp, rel);
  mkdirSync(join(tmp, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(abs, content);
}

function commit(msg: string): void {
  git("add", "-A");
  git("commit", "-qm", msg);
}

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await post(path, body);
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function createBranch(
  intent: string,
  agent: string,
  touches: string[],
  base?: string,
): Promise<string> {
  const res = await postJson("/api/branches", {
    intent,
    agent_id: agent,
    touches,
    ...(base ? { base } : {}),
  });
  expect(res.name).toMatch(/^bl\//);
  return res.name as string;
}

async function mergeBranch(branch: string): Promise<any> {
  return postJson("/api/merge", { branch });
}

const SHARED_V1 = `line01
line02
line03
line04
line05
line06
line07
line08
line09
mode = "slow"
line11
line12
line13
line14
line15
line16
line17
line18
line19
line20
`;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bl-api-test-"));
  git("init", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@local");
  write("README.md", "# branchline test repo\n");
  commit("commit 1: readme");
  write("src/shared.txt", SHARED_V1);
  commit("commit 2: shared fixture");
  base0 = git("rev-parse", "HEAD");

  const env = { DB: new InMemoryDb(), REPO_PATH: tmp };
  app = createApp(env);
});

describe("branches", () => {
  it("POST /api/branches -> 201 with a branch name and manifest", async () => {
    const res = await post("/api/branches", {
      intent: "smoke test branch",
      agent_id: "agent-9",
      touches: ["src/smoke/**"],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toMatch(/^bl\/agent-9-smoke-test-branch-/);
    expect(body.manifest.status).toBe("open");
    expect(body.manifest.touches).toEqual(["src/smoke/**"]);
    expect(body.manifest.base).toMatch(/^[0-9a-f]{40}$/);
  });

  it("GET /api/branches lists the created branch", async () => {
    const name = await createBranch("list me", "agent-9", ["src/list/**"]);
    const res = await app.request("/api/branches");
    expect(res.status).toBe(200);
    const { branches: rows } = await res.json();
    expect(rows.map((r: any) => r.name)).toContain(name);
  });

  it("rejects a bad body with 400", async () => {
    const res = await post("/api/branches", { intent: "", agent_id: "x", touches: [] });
    expect(res.status).toBe(400);
  });
});

describe("diff", () => {
  it("GET /api/diff shows the branch's .branchline.json addition", async () => {
    const name = await createBranch("diff me", "agent-9", ["src/diff/**"]);
    const res = await app.request(
      `/api/diff?from=main&to=${encodeURIComponent(name)}`,
    );
    expect(res.status).toBe(200);
    const ops = await res.json();
    const meta = ops.find((o: any) => o.file === ".branchline.json");
    expect(meta).toBeDefined();
    expect(meta.status).toBe("added");
  });

  it("400s without from/to", async () => {
    const res = await app.request("/api/diff?from=main");
    expect(res.status).toBe(400);
  });
});

describe("merge tiers", () => {
  it("tier 1: disjoint branch merges cleanly and lands on main", async () => {
    const name = await createBranch("add file a", "t1", ["src/a/**"], base0);
    write("src/a/one.txt", "one\n");
    commit("t1: add one.txt");
    const d = await mergeBranch(name);
    expect(d.tier).toBe(1);
    expect(d.status).toBe("merged");
    expect(d.merge_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(tmp, "src/a/one.txt"))).toBe(true);
  });

  it("tier 1 is reachable even though every branch carries .branchline.json (regression)", async () => {
    // main now holds branch A's .branchline.json; branch B (based at base0,
    // before A's merge) carries its own. Without the .branchline.json
    // exclusion in the merge route this would classify as tier 2.
    const name = await createBranch("add file b", "t1b", ["src/b/**"], base0);
    write("src/b/two.txt", "two\n");
    commit("t1b: add two.txt");
    const d = await mergeBranch(name);
    expect(d.tier).toBe(1);
    expect(d.status).toBe("merged");
    expect(existsSync(join(tmp, "src/b/two.txt"))).toBe(true);
  });

  it("tier 2: two branches editing different regions of one file", async () => {
    const head = await createBranch("edit head", "t2", ["src/shared.txt"], base0);
    write("src/shared.txt", SHARED_V1.replace("line02\n", "line02 EDITED-BY-HEAD\n"));
    commit("t2: edit head region");
    const d1 = await mergeBranch(head);
    expect(d1.tier).toBe(1);
    expect(d1.status).toBe("merged");

    const tail = await createBranch("edit tail", "t2", ["src/shared.txt"], base0);
    write("src/shared.txt", SHARED_V1.replace("line18\n", "line18 EDITED-BY-TAIL\n"));
    commit("t2: edit tail region");
    const d2 = await mergeBranch(tail);
    expect(d2.tier).toBe(2);
    expect(d2.status).toBe("merged");
    const onMain = readFileSync(join(tmp, "src/shared.txt"), "utf8");
    expect(onMain).toContain("EDITED-BY-HEAD");
    expect(onMain).toContain("EDITED-BY-TAIL");
  });

  it("tier 3: same-line conflict -> needs-resolution with a structured artifact", async () => {
    const fast = await createBranch("set mode fast", "t3", ["src/shared.txt"], base0);
    write("src/shared.txt", SHARED_V1.replace('mode = "slow"', 'mode = "fast"'));
    commit("t3: mode fast");
    const d1 = await mergeBranch(fast);
    // main already touched src/shared.txt (the tier-2 merge above), so the
    // file-level classification overlaps; the line regions are disjoint, so
    // the three-way merge succeeds -> tier 2.
    expect(d1.tier).toBe(2);
    expect(d1.status).toBe("merged");

    const turbo = await createBranch("set mode turbo", "t3", ["src/shared.txt"], base0);
    write("src/shared.txt", SHARED_V1.replace('mode = "slow"', 'mode = "turbo"'));
    commit("t3: mode turbo");

    const res = await post("/api/merge", { branch: turbo });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // no raw conflict markers anywhere in the response
    expect(raw).not.toContain(MARKER);
    const d = JSON.parse(raw);
    expect(d.tier).toBe(3);
    expect(d.status).toBe("needs-resolution");
    expect(d.merge_sha).toBeUndefined();
    expect(d.conflicts).toHaveLength(1);
    const c = d.conflicts[0];
    expect(c.file).toBe("src/shared.txt");
    expect(c.base).toContain('mode = "slow"');
    expect(c.ours).toContain('mode = "turbo"');
    expect(c.theirs).toContain('mode = "fast"');
    expect(c.ours_manifest.agent_id).toBe("t3");
    expect(c.theirs_manifest).toBeDefined();
    expect(c.overlapping_ranges.length).toBeGreaterThan(0);

    // the working tree is untouched: no markers, clean status
    expect(git("status", "--porcelain")).toBe("");
    let grepOut = "";
    try {
      grepOut = execFileSync("git", ["-C", tmp, "grep", "-r", MARKER, "--", "."], {
        encoding: "utf8",
      });
    } catch (err: any) {
      // git grep exits 1 when nothing matches
      expect(err.status).toBe(1);
    }
    expect(grepOut).toBe("");

    // branch row reflects the conflict
    const { branches: rows } = await (await app.request("/api/branches")).json();
    const row = rows.find((r: any) => r.name === turbo);
    expect(row.status).toBe("needs-resolution");
  });
});

describe("queue + dashboard + errors", () => {
  it("GET /api/queue lists merge jobs including the tier-3 one", async () => {
    const res = await app.request("/api/queue");
    expect(res.status).toBe(200);
    const { queue: jobs } = await res.json();
    expect(jobs.length).toBeGreaterThanOrEqual(6);
    const conflicted = jobs.filter((j: any) => j.status === "needs-resolution");
    expect(conflicted.length).toBeGreaterThanOrEqual(1);
    expect(conflicted[0].tier).toBe(3);
    expect(conflicted[0].artifact.conflicts[0].file).toBe("src/shared.txt");
  });

  it("GET / renders dashboard HTML containing a branch name", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Branchline");
    expect(html).toContain("bl/");
  });

  it("404s on merge of an unknown branch", async () => {
    const res = await post("/api/merge", { branch: "bl/does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("401s on mutating routes when BL_TOKEN is set and no token is sent", async () => {
    const guarded = createApp({ DB: new InMemoryDb(), REPO_PATH: tmp, BL_TOKEN: "s3cret" });
    const denied = await guarded.request("/api/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "x", agent_id: "y", touches: ["z"] }),
    });
    expect(denied.status).toBe(401);
    const wrong = await guarded.request("/api/branches", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ intent: "x", agent_id: "y", touches: ["z"] }),
    });
    expect(wrong.status).toBe(401);
  });
});

describe("queue consumer", () => {
  it("POST /api/merge returns 202 with a queue binding; queue() processes the job", async () => {
    const sent: unknown[] = [];
    const qEnv = {
      DB: new InMemoryDb(),
      REPO_PATH: tmp,
      MERGE_QUEUE: { send: async (m: unknown) => { sent.push(m); } },
    };
    const qApp = createApp(qEnv);
    const qPost = (path: string, body: unknown) =>
      qApp.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const created = await (await qPost("/api/branches", {
      intent: "queued job",
      agent_id: "agent-q",
      touches: ["src/queued/**"],
    })).json();
    const name = created.name as string;
    write("src/queued/job.txt", "queued\n");
    commit("agent-q: queued change");

    const mres = await qPost("/api/merge", { branch: name });
    expect(mres.status).toBe(202);
    const { id, status } = await mres.json();
    expect(status).toBe("queued");
    expect(sent).toHaveLength(1);

    // Drive the consumer like the Workers runtime would.
    const acks: string[] = [];
    await worker.queue(
      { messages: [{ body: sent[0], ack: () => acks.push("ack") }] },
      qEnv,
    );
    expect(acks).toEqual(["ack"]);

    const { queue } = await (await qApp.request("/api/queue")).json();
    const job = queue.find((j: any) => j.id === id);
    expect(job.status).toBe("merged");
    expect(job.tier).toBe(1);
    expect(existsSync(join(tmp, "src/queued/job.txt"))).toBe(true);
  });
});
