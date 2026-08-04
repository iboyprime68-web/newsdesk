#!/usr/bin/env bash
# Creates the orphan `state` branch that CI commits run-state to. Run once after repo
# creation. Uses plumbing so the working tree is never touched (a `git switch --orphan`
# would clear your tracked files mid-setup).
set -euo pipefail
tmp=$(mktemp)
printf '{"version":1}\n' > "$tmp"
blob=$(git hash-object -w "$tmp")
tree=$(printf '100644 blob %s\tstate.json\n' "$blob" | git mktree)
commit=$(git commit-tree "$tree" -m "init state")
git push origin "$commit:refs/heads/state"
rm -f "$tmp"
echo "state branch created at $commit"
