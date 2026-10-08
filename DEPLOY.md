# Deploying Branchline to Cloudflare

The MVP is fully working **locally** (see README.md). This doc covers what
stands between the repo and a production deployment, and exactly what is
needed from P to do it. **Nothing here has been deployed** — no Cloudflare
credentials exist in this environment.

## What P needs to provide

1. **Cloudflare account access** — one of:
   - `wrangler login` (OAuth, interactive), or
   - a Cloudflare **API token** with permissions: Workers Scripts (edit),
     D1 (edit), KV (edit), Queues (edit). (`CLOUDFLARE_API_TOKEN` env var;
     also needs the **Account ID**.)
2. **Confirmation of the Artifacts namespace** to use for the git backend
   (or "skip Artifacts for now" — see below).

No other secrets are required. `BL_TOKEN` (repo-scoped API token for the
worker's mutating routes) is set at deploy time via
`wrangler secret put BL_TOKEN` — P chooses the value.

## Provisioning checklist (run in `apps/api/`)

```bash
# 1. authenticate
wrangler login            # or export CLOUDFLARE_API_TOKEN=...

# 2. D1 — branch registry + merge queue state
wrangler d1 create branchline
# -> paste database_id into wrangler.toml [[d1_databases]]
wrangler d1 execute branchline --remote --file=../../schema/001_init.sql
wrangler d1 execute branchline --remote --file=../../schema/002_merge_sha.sql

# 3. KV — diff-response cache (optional; worker falls back to in-memory)
wrangler kv namespace create DIFF_CACHE
# -> paste id into wrangler.toml [[kv_namespaces]]

# 4. Queues — merge jobs
wrangler queues create branchline-merge

# 5. secrets / vars
wrangler secret put BL_TOKEN

# 6. deploy
wrangler deploy
```

## Bindings the worker uses

| Binding       | Type     | Purpose                                              | Status        |
|---------------|----------|------------------------------------------------------|---------------|
| `DB`          | D1       | branch registry, intent manifests, merge-queue state | ready         |
| `DIFF_CACHE`  | KV       | `GET /api/diff` response cache (1h TTL)              | ready (optional; in-memory fallback) |
| `MERGE_QUEUE` | Queues   | merge-job producer + consumer                        | ready         |
| `ARTIFACTS`   | Artifacts| git backend (repos as a service)                     | **not implemented** — see below |

## Known production gap: the Artifacts GitBackend

The worker is written against the `GitBackend` interface
(`packages/core/src/types.ts`). The only implementation today is
`LocalGitBackend`, which shells out to the `git` binary against a working
repo at `REPO_PATH` — fine for local dev and self-hosted, unusable on
Workers.

The production implementation must be written against the [Artifacts
Workers binding](https://developers.cloudflare.com/artifacts/get-started/workers/)
(`[[artifacts]]` in `wrangler.toml`, already stubbed there commented out)
and selected in `createBackend()` (`apps/api/src/git/local-git.ts`).
Binding `ARTIFACTS` today makes the worker fail loudly rather than silently
misbehave — that is intentional.

Estimated shape of the work: implement `GitBackend` over Artifacts repo
handles (create branch ≈ fork/create ref, readFile ≈ read blob at ref,
merge ≈ apply tree, etc.), then uncomment the `[[artifacts]]` block and
deploy. Until then, production deploys should keep `ARTIFACTS` unbound and
will fail on any git operation — **do not deploy to production until the
Artifacts backend exists**, unless the goal is only to serve the dashboard
and branch registry (which need no git).

## What works the day it deploys (with D1 + Queues, no Artifacts)

- Branch registry API + dashboard (no git needed)
- Merge queue accepts jobs (202 queued) and the consumer processes them —
  but every job will fail at the git step until the Artifacts backend lands.
