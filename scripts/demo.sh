#!/usr/bin/env bash
#
# Branchline competition video rehearsal.
#
# Simulates four coding agents racing on one repo. All branches are cut from
# the SAME base commit — the parallelism lives in the branch graph; the demo
# runs the agents sequentially for a deterministic recording.
#
#   agent-1: adds src/auth/oauth.ts            -> tier 1 (disjoint files)
#   agent-2: adds src/billing/refund.ts         -> tier 1 (disjoint files)
#   agent-3: edits login.ts line 5             -> tier 1 (disjoint files)
#   agent-4: edits login.ts lines 36-38        -> tier 2 (same file, other hunk)
#   agent-2 (2nd task): edits login.ts line 5  -> tier 3 (same line, conflict)
#
# Usage: bash scripts/demo.sh   (from the repo root)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [[ -n "${REPO:-}" ]]; then rm -rf "$REPO"; fi
  if [[ -n "${SRVLOG:-}" ]]; then rm -f "$SRVLOG"; fi
  if [[ -n "${BUILDLOG:-}" ]]; then rm -f "$BUILDLOG"; fi
}
trap cleanup EXIT

fail() { echo "ASSERT FAIL: $*" >&2; exit 1; }

# --- 1. throwaway repo -------------------------------------------------------
REPO="$(mktemp -d)"
SRVLOG="$(mktemp)"
BUILDLOG="$(mktemp)"
git -C "$REPO" init -qb main
git -C "$REPO" config user.name "demo"
git -C "$REPO" config user.email "demo@local"

# ~50-line fixture with distinct regions (line numbers matter, see agents below)
mkdir -p "$REPO/src/auth" "$REPO/src/billing"
cat > "$REPO/src/auth/login.ts" <<'EOF'
// src/auth/login.ts — demo fixture: distinct regions for parallel agents.
// Region A (top): login policy constants — agent-3 edits line 5.
// Region B (middle): attempt tracking — agent-4 edits lines 36-38.

export const MAX_LOGIN_ATTEMPTS = 5;
export const SESSION_TTL_SECONDS = 3600;

export interface Credentials {
  username: string;
  password: string;
}

export interface Session {
  token: string;
  username: string;
  expiresAt: number;
}

export function validateUsername(username: string): boolean {
  return /^[a-z0-9_]{3,20}$/.test(username);
}

export function validatePassword(password: string): boolean {
  return password.length >= 12;
}

// --- Region B: attempt tracking ---
const attempts = new Map<string, number>();

export function recordAttempt(username: string): number {
  const n = (attempts.get(username) ?? 0) + 1;
  attempts.set(username, n);
  return n;
}

export function isLockedOut(username: string): boolean {
  return (attempts.get(username) ?? 0) >= MAX_LOGIN_ATTEMPTS;
}

export function resetAttempts(username: string): void {
  attempts.delete(username);
}

export function createSession(username: string): Session {
  return {
    token: `sess_${Date.now()}_${username}`,
    username,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
}
EOF

cat > "$REPO/src/billing/invoice.ts" <<'EOF'
export interface Invoice {
  id: string;
  amountCents: number;
}

export function total(inv: Invoice): number {
  return inv.amountCents;
}
EOF

cat > "$REPO/README.md" <<'EOF'
# Branchline demo repo
EOF

git -C "$REPO" add -A && git -C "$REPO" commit -qm "initial commit"
BASE="$(git -C "$REPO" rev-parse HEAD)"
echo "repo: $REPO  base: ${BASE:0:8}"

# --- 2. build the CLI ---------------------------------------------------------
if ! (cd "$ROOT/apps/cli" && npm run build >"$BUILDLOG" 2>&1); then
  echo "CLI build failed:"; cat "$BUILDLOG"; exit 1
fi

# --- 3. start the API ----------------------------------------------------------
# NOTE: tsx is pointed at apps/api/tsconfig.json so dashboard.tsx compiles with
# the same jsx:react-jsx + jsxImportSource:hono/jsx settings tsc uses.
PORT=8787 REPO_PATH="$REPO" "$ROOT/node_modules/.bin/tsx" \
  --tsconfig "$ROOT/apps/api/tsconfig.json" \
  "$ROOT/apps/api/src/local-server.ts" >"$SRVLOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:8787/" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:8787/" >/dev/null || {
  echo "API server did not start. Log:"; cat "$SRVLOG"; exit 1
}
echo "api: http://127.0.0.1:8787 (pid $SERVER_PID)"

# NOTE: citty parses options per subcommand, so `--api` must come after the
# subcommand name or come from the environment (see apps/cli/src/index.ts).
# The env var keeps every invocation short.
export BL_API="http://127.0.0.1:8787"
BL="node $ROOT/apps/cli/dist/index.js"

# --- helpers ------------------------------------------------------------------
mkbranch() { # <intent> <touches> <agent> -> prints branch name
  $BL branch --intent "$1" --touches "$2" --agent "$3" --base "$BASE" | sed 's/^created //'
}

# The API checks the new branch out server-side during `bl branch`; the
# explicit checkout below pins the demo to that contract so each agent's file
# writes land on its own branch even if server behavior changes.
checkout_branch() { git -C "$REPO" checkout -q "$1"; }

assert_merge() { # <merge-output> <expected "tier=N status=S">
  grep -q "^$2\$" <<<"$1" || fail "expected merge '$2', got: $(head -1 <<<"$1")"
}

# --- 5. the four agents ---------------------------------------------------------
echo "--- agent-1: add oauth login (src/auth/**) ---"
B1="$(mkbranch "add oauth login" "src/auth/**" "agent-1")"
checkout_branch "$B1"
cat > "$REPO/src/auth/oauth.ts" <<'EOF'
export const OAUTH_PROVIDER = "demo-idp";

export function oauthUrl(state: string): string {
  return `https://idp.example/authorize?state=${state}`;
}
EOF
git -C "$REPO" add -A && git -C "$REPO" commit -qm "agent-1: add oauth login"
M1="$($BL merge "$B1")"
assert_merge "$M1" "tier=1 status=merged"
echo "$M1" | head -1

echo "--- agent-2: add refunds (src/billing/**) ---"
B2="$(mkbranch "add refunds" "src/billing/**" "agent-2")"
checkout_branch "$B2"
cat > "$REPO/src/billing/refund.ts" <<'EOF'
export function refund(invoiceId: string, amountCents: number): string {
  return `refund:${invoiceId}:${amountCents}`;
}
EOF
git -C "$REPO" add -A && git -C "$REPO" commit -qm "agent-2: add refunds"
M2="$($BL merge "$B2")"
assert_merge "$M2" "tier=1 status=merged"
echo "$M2" | head -1

echo "--- agent-3: tighten login attempts (src/auth/**, line 5) ---"
B3="$(mkbranch "tighten login attempts" "src/auth/**" "agent-3")"
checkout_branch "$B3"
sed -i 's/const MAX_LOGIN_ATTEMPTS = 5;/const MAX_LOGIN_ATTEMPTS = 3;/' "$REPO/src/auth/login.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "agent-3: 5 -> 3 attempts"
M3="$($BL merge "$B3")"
assert_merge "$M3" "tier=1 status=merged"
echo "$M3" | head -1

echo "--- agent-4: strict lockout (src/auth/**, lines 36-38) ---"
B4="$(mkbranch "strict lockout check" "src/auth/**" "agent-4")"
checkout_branch "$B4"
sed -i '36,38c\export function isLockedOut(username: string): boolean {\n  return (attempts.get(username) ?? 0) > MAX_LOGIN_ATTEMPTS;\n}' \
  "$REPO/src/auth/login.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "agent-4: strict lockout"
M4="$($BL merge "$B4")"
assert_merge "$M4" "tier=2 status=merged"
echo "$M4" | head -1

echo "--- agent-2 (task 2): loosen login attempts (src/auth/**, SAME line 5) ---"
B5="$(mkbranch "loosen login attempts" "src/auth/**" "agent-2")"
checkout_branch "$B5"
sed -i 's/const MAX_LOGIN_ATTEMPTS = 5;/const MAX_LOGIN_ATTEMPTS = 10;/' "$REPO/src/auth/login.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "agent-2: 5 -> 10 attempts"
M5="$($BL merge "$B5")"
assert_merge "$M5" "tier=3 status=needs-resolution"
echo "$M5" | head -2
echo "$M5" | grep -q "conflict: src/auth/login.ts overlapping ranges: 5-5" \
  || fail "expected structured conflict on login.ts range 5-5"

# --- 6. assertions ---------------------------------------------------------------
echo "--- assertions ---"

# no raw conflict markers anywhere in the repo
if git -C "$REPO" grep -q '<<<<<<<' 2>/dev/null; then
  fail "conflict markers found in working tree"
fi
echo "ok: no conflict markers"

# main carries agent-1/2/3/4 content (agent-2 task 2 stays unmerged)
git -C "$REPO" show main:src/auth/oauth.ts | grep -q "OAUTH_PROVIDER" \
  || fail "main missing agent-1 oauth.ts"
git -C "$REPO" show main:src/billing/refund.ts | grep -q "refund:" \
  || fail "main missing agent-2 refund.ts"
git -C "$REPO" show main:src/auth/login.ts | grep -q "MAX_LOGIN_ATTEMPTS = 3" \
  || fail "main missing agent-3 line-5 edit"
git -C "$REPO" show main:src/auth/login.ts | grep -q "> MAX_LOGIN_ATTEMPTS" \
  || fail "main missing agent-4 lockout edit"
echo "ok: main contains agent-1/2/3/4 content"

# D1 registry: bl branches lists all 5 branches with the right statuses
BRANCHES="$($BL branches)"
echo "$BRANCHES" | grep -c "^bl/" | grep -q "^5$" \
  || fail "expected 5 branches, got: $BRANCHES"
for spec in "$B1:merged" "$B2:merged" "$B3:merged" "$B4:merged" "$B5:needs-resolution"; do
  name="${spec%%:*}"; want="${spec##*:}"
  echo "$BRANCHES" | grep -q "$name.*$want" \
    || fail "branch $name not '$want' in: $BRANCHES"
done
echo "ok: 5 branches, statuses merged x4 + needs-resolution x1"

# merge queue shows the tier-3 job
QUEUE="$($BL queue)"
echo "$QUEUE" | grep -q "$B5.*needs-resolution" \
  || fail "tier-3 job missing from queue: $QUEUE"
echo "ok: queue shows the tier-3 needs-resolution job"

echo
echo "DEMO PASS"
echo "  tier-1 merges:        3 (agent-1 oauth, agent-2 refund, agent-3 login line 5)"
echo "  tier-2 merges:        1 (agent-4 login lines 36-38, same file, other hunk)"
echo "  tier-3 needs-resolution: 1 (agent-2 task 2 vs agent-3, same line, structured artifact)"
