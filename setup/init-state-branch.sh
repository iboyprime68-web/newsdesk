#!/usr/bin/env bash
# Creates the orphan `state` branch that CI commits run-state to. Run once after repo creation.
set -euo pipefail
git switch --orphan state
echo '{"version":1}' > state.json
git add state.json
git commit -m "init state"
git push -u origin state
git switch main
echo "state branch initialised"
