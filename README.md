# Branchline

**Semantic branches and a deterministic merge queue for parallel AI coding agents.**

When 50 agents share one repo, branch names like `feat/x-final-v2` are
useless and merges are a coin flip. Branchline gives every agent branch a
machine-readable **intent manifest** (`{intent, agent_id, touches, base,
status}`) and merges through a **deterministic three-tier queue**:

- **Tier 1** — disjoint touched-file sets → auto-merge (fast-forward or `--no-ff`).
- **Tier 2** — same files, non-overlapping hunks → 3-way text merge.
- **Tier 3** — real conflicts → structured conflict artifact
  `{base, ours, theirs, both intent manifests}`. Raw `<<<<<<<` markers are
  **never** emitted to agents; the merge is marked `needs-resolution`.

Built for the Cloudflare **"Build the next Git platform"** competition
(deadline 2026-10-14). TypeScript everywhere, Cloudflare-native.

## Architecture

```
                    ┌─────────────────────────────────────┐
  agents ──bl CLI──▶│  apps/api  (Cloudflare Worker/Hono) │
  (citty)           │                                     │
                    │  POST /api/branches  → D1 + git     │
                    │  GET  /api/diff?from&to → JSON diff│
                    │  POST /api/merge      → queue tiers │
                    │  GET  /api/queue      → job states  │
                    │  GET  /               → dashboard   │
                    └──────────┬────────────┬─────────────┘
                               │            │
                    ┌──────────▼───┐  ┌─────▼────────┐
                    │  D1 / KV /   │  │ GitBackend   │
                    │  Queues      │  │ interface    │
                    └──────────────┘  └─────┬────────┘
                                            │ implements
                                   ┌────────▼─────────┐
                                   │ LocalGitBackend  │  (dev/test:
                                   │ (git CLI)        │   working repo)
                                   │ ArtifactsBackend │  (future: prod)
                                   └──────────────────┘

  packages/core — pure logic, no I/O:
    manifest.ts  intent schema (zod) + branch naming
    diff.ts      agent-readable FileOp[] from file-content maps
    merge.ts     glob attribution, 3-way merge (node-diff3),
                 decideMerge() → tier 1/2/3  (no conflict markers, ever)
```

Merge flow: `POST /api/merge` enqueues the job in D1. With a `MERGE_QUEUE`
binding it returns `202 queued` and the queue consumer processes it;
without one (local dev) it processes inline. Either way the decision is
pure and deterministic: same inputs → same tier, same result.

## Run it locally

Prereqs: Node 24+, git.

```bash
git clone <repo> && cd branchline
npm install

# 1. start a scratch repo for agents to work in
git init -b main /tmp/bl-repo && cd /tmp/bl-repo
echo hello > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm init
cd -

# 2. start the API (in-memory D1 shim; real D1 in production)
REPO_PATH=/tmp/bl-repo PORT=8787 npx tsx apps/api/src/local-server.ts

# 3. in another shell: build the CLI and create a semantic branch
cd apps/cli && npm run build && cd -
BL=node apps/cli/dist/index.js
$BL branch --intent "add oauth login" --touches "src/auth/**" --agent agent-1
$BL branches
```

Useful env vars: `BL_API` (API base URL, default `http://127.0.0.1:8787`),
`BL_TOKEN` (repo-scoped token; also set server-side to require auth).

## The demo rehearsal

`scripts/demo.sh` is the competition-video rehearsal — 4 simulated agents,
same base, sequential merges across all three tiers:

| Agent | Change | Merge |
|---|---|---|
| agent-1 | new `src/auth/oauth.ts` | tier 1 |
| agent-2 | new `src/billing/refund.ts` | tier 1 |
| agent-3 | `src/auth/login.ts` line 5 | tier 1 |
| agent-4 | `src/auth/login.ts` lines 36–38 (other hunk) | tier 2 |
| agent-2 (task 2) | `src/auth/login.ts` line 5, conflicting value | tier 3 → `needs-resolution` + structured artifact |

```bash
bash scripts/demo.sh   # spins up API + repo, asserts every tier, prints DEMO PASS
```

Assertions: correct tier per merge, no `<<<<<<<` anywhere, merged content
present on `main`, D1 registry consistent (5 branches: 4 merged, 1
needs-resolution).

## Tests

```bash
npm test            # vitest: unit (core) + API integration (Hono app.request, temp git repo, D1 shim)
```

53 tests green. `npx tsc --noEmit` clean in `packages/core`, `apps/api`, `apps/cli`.
## Competition submission notes

- Entry: **Branchline** — "Git rebuilt for parallel agents".
- License: **Apache-2.0** (competition-compatible).
- What's real: semantic branches + D1 registry, agent-readable JSON diffs,
  deterministic 3-tier merge queue, Bearer-token auth stub,
  server-rendered dashboard, full local test suite + demo rehearsal.
- What's stubbed (documented, not hidden): KV diff cache falls back to
  in-memory; merge queue processes inline without a Queue binding; the
  **Artifacts GitBackend is not implemented** — `LocalGitBackend` (git CLI
  on a working repo) is the dev/test double behind the same interface.
  See `DEPLOY.md` for the production path and the exact credentials needed.

## Layout

```
apps/api/        Cloudflare Worker (Hono): routes, dashboard, LocalGitBackend, D1 shim
apps/cli/        bl CLI (citty): branch, commit, branches, diff, merge, queue
packages/core/   pure logic: manifest schema, diff format, merge tiers
schema/          D1 migrations (001_init, 002_merge_sha)
scripts/demo.sh  4-agent competition rehearsal
tests/           vitest unit + integration
```
