#!/usr/bin/env bash
# Launch the Catalyst Coach GUI from anywhere.
# Resolves the repo root from this script's location so it works no matter
# where it's invoked from.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

exec python3 -m catalyst_gui "$@"
