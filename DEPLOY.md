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
2. **An Artifacts namespace + repo for the git backend**:
   - Create the namespace (dashboard or API), then create the repo, e.g.
     via the setup prompt in the [Artifacts
     docs](https://developers.cloudflare.com/artifacts/get-started/workers/),
     or `artifacts.create("branchline", { setDefaultBranch: "main" })`
     from a Worker. Note the **git remote URL** from the create output.
   - Push an initial commit to `main` (an empty repo cannot be cloned).
   - Set vars: `BL_REPO` (default `"branchline"`) and `BL_REMOTE`
     (the git remote URL) in `wrangler.toml` `[vars]`, or via
     `wrangler secret put` / `--var` at deploy time. `BL_REMOTE` is only
     skippable if the binding's repo handle exposes `remote` itself —
     assume it is required until proven otherwise against live credentials.

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

# 5. Artifacts — git backend repo
#    create the namespace + repo (dashboard, API, or the docs' setup prompt),
#    push an initial commit to main, then set BL_REPO / BL_REMOTE in
#    wrangler.toml [vars] (see "What P needs to provide" §2).

# 6. secrets / vars
wrangler secret put BL_TOKEN

# 7. deploy
wrangler deploy
```

## Bindings the worker uses

| Binding       | Type     | Purpose                                              | Status        |
|---------------|----------|------------------------------------------------------|---------------|
| `DB`          | D1       | branch registry, intent manifests, merge-queue state | ready         |
| `DIFF_CACHE`  | KV       | `GET /api/diff` response cache (1h TTL)              | ready (optional; in-memory fallback) |
| `MERGE_QUEUE` | Queues   | merge-job producer + consumer                        | ready         |
| `ARTIFACTS`   | Artifacts| git backend (repos as a service)                     | **implemented** — `ArtifactsGitBackend` (see below) |

## The Artifacts GitBackend (implemented, not yet run live)

The worker is written against the `GitBackend` interface
(`packages/core/src/types.ts`). `ArtifactsGitBackend`
(`apps/api/src/git/artifacts-git.ts`) implements it for production:

- **Reads** (`revParse`, `branchExists`, `listFiles`, `readFile`) use the
  binding's native operations (`log`, `readFile`, `readCommit`/`readTree`).
  `listFiles` falls back to a clone + `git.walk` if the binding's tree
  shapes differ from the documented ones.
- **Mutations** clone the repo into an in-memory filesystem
  (`apps/api/src/git/memory-fs.ts`, clean-room), apply the change with
  isomorphic-git, and push — one full clone per backend instance (i.e. per
  request/queue batch), reused across that instance's ops. Artifacts is the
  source of truth; nothing persists in the Worker.
- **Auth**: a repo-scoped write token is minted per instance via
  `repo.createToken("write", 3600)` and cached until 60s before expiry.
  The `?expires=` suffix is stripped for git Basic auth (username `x`).
  Tokens never appear in logs or error messages.
- **Merge**: `git.merge` with a custom driver — fast-forwards when
  possible, else a merge commit; `.branchline.json` resolves in favor of
  the merged branch (the `-X theirs` equivalent; D1 is the source of truth
  for manifests). Any other conflict fails loudly — agents never see raw
  `<<<<<<<` markers.
- **wrangler**: the `[[artifacts]]` block is active in
  `apps/api/wrangler.toml`, and `compatibility_flags = ["nodejs_compat"]`
  is set because isomorphic-git requires Node's `Buffer`.

**Honest verification gap** (no live Artifacts credentials exist in this
environment): the binding call shapes (`log` entry fields, `readTree`
entry fields, `readBlob`, `createToken` response) are implemented from the
docs and handled defensively, but the mutation path (clone/push against a
real Artifacts remote) has not been exercised end-to-end. The first deploy
should run the demo script against the deployed worker and watch for
`artifacts git <op> failed` errors, which name the exact failing primitive.

## What works the day it deploys (D1 + Queues + Artifacts bound)

- Branch registry API + dashboard
- Full git backend: semantic branches, JSON diffs, 3-tier merge queue —
  the queue consumer processes jobs against the Artifacts repo
- First-deploy smoke test: run the demo script (`npm run demo`) against
  the deployed worker URL and confirm merges land; check logs for
  `artifacts git <op> failed` (names the exact failing primitive)
