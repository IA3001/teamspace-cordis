#!/usr/bin/env bash
# GitHub Actions (or local) CI entry point for a direct push.
set -euo pipefail
cd "$(dirname "$0")/.."

# GitHub Actions exposes the event commit as GITHUB_SHA. Accept an explicit SHA
# for local/other runner use, and fail closed rather than attest another checkout.
event_commit="${GITHUB_SHA:-${1:-}}"
if [[ -z "$event_commit" ]]; then
  echo "GITHUB_SHA (or an explicit commit argument) is required." >&2
  exit 1
fi
checked_out_sha="$(git rev-parse HEAD)"
event_sha="$(git rev-parse --verify "${event_commit}^{commit}")"
if [[ "$checked_out_sha" != "$event_sha" ]]; then
  echo "CI event commit $event_sha does not match checkout $checked_out_sha" >&2
  exit 1
fi

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_minor="${node_version#*.}"
node_minor="${node_minor%%.*}"
if (( node_major < 22 || (node_major == 22 && node_minor < 5) )); then
  echo "Node.js >=22.5.0 is required; found $node_version" >&2
  exit 1
fi

npm ci
node node_modules/playwright-core/cli.js install --with-deps chromium
npm run gate
