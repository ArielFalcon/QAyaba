#!/usr/bin/env bash
# Configure the required `ci` status check (see .github/workflows/ci.yml): make it REQUIRED
# before anything merges to main, and enable auto-merge.
#
# Run ONCE, with a token that has admin on the repo:
#   GITHUB_TOKEN=<admin-token> ./scripts/setup-branch-protection.sh [owner/repo]
#
# Human PR reviews are intentionally not required. The required `ci` check is the server-side
# guarantee that a change failing typecheck/tests can never land on main.
set -euo pipefail

REPO="${1:-ArielFalcon/qayaba}"
: "${GITHUB_TOKEN:?set GITHUB_TOKEN (needs admin on the repo)}"

api() {
  local method="$1" path="$2"
  shift 2
  curl -fsSL -X "$method" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/${path}" "$@"
}

# Allow auto-merge, and guarantee squash merges are enabled.
echo "→ enabling 'Allow auto-merge' + squash merges on ${REPO}"
api PATCH "repos/${REPO}" -d '{"allow_auto_merge":true,"allow_squash_merge":true}' >/dev/null

# strict:false on purpose — "strict" requires a PR to be up to date with main before merging,
# which deadlocks a PR when main advanced during CI. The `ci` check still runs on the PR head,
# which is the guarantee we want.
echo "→ requiring the 'ci' status check on ${REPO}@main (enforced on admins)"
api PUT "repos/${REPO}/branches/main/protection" -d '{
  "required_status_checks": { "strict": false, "contexts": ["ci"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}' >/dev/null

echo "✓ branch protection configured: main now requires the 'ci' check; auto-merge enabled."
