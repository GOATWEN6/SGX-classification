#!/usr/bin/env bash

# Read-only: no lease, model loading, credential file, or process mutation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/layout-lib.sh"
python3 "$SCRIPT_DIR/../tools/status-stack.py" "$SGX_ROOT" "$SGX_RUNTIME_ROOT"
