#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=layout-lib.sh
source "$SCRIPT_DIR/layout-lib.sh"

SGX_DRY_RUN=0
if [[ "${1:-}" == '--dry-run' ]]; then
  SGX_DRY_RUN=1
  shift
fi
[[ "$#" -eq 1 ]] || sgx_die 'usage: activate-release.sh [--dry-run] <full-git-sha>'

release_id="$1"
target="releases/$release_id"
sgx_require_layout
sgx_require_verified_release "$release_id"

current_target=''
if sgx_link_exists current; then
  current_target="$(sgx_read_managed_link current)"
fi
if sgx_link_exists previous; then
  sgx_read_managed_link previous >/dev/null
fi

if [[ "$current_target" == "$target" ]]; then
  printf 'release already active: %s\n' "$release_id"
  exit 0
fi

# Update previous first. If the current switch is interrupted, retrying this
# command is safe and preserves the same prior release.
if [[ -n "$current_target" ]]; then
  sgx_atomic_symlink "$current_target" previous
fi
sgx_atomic_symlink "$target" current

printf '%s release: %s\n' "$([[ "$SGX_DRY_RUN" == '1' ]] && printf 'would activate' || printf 'activated')" "$release_id"
