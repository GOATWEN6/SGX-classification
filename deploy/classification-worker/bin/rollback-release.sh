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
[[ "$#" -eq 2 ]] || sgx_die 'usage: rollback-release.sh [--dry-run] <target-sha> <expected-current-sha>'

target_id="$1"
expected_current_id="$2"
target="releases/$target_id"
expected_current="releases/$expected_current_id"
sgx_require_layout
sgx_require_verified_release "$target_id"
sgx_require_verified_release "$expected_current_id"

current_target="$(sgx_read_managed_link current)"
previous_target="$(sgx_read_managed_link previous)"

if [[ "$current_target" == "$target" ]]; then
  if [[ "$previous_target" == "$expected_current" ]]; then
    printf 'rollback already complete: current=%s previous=%s\n' "$target_id" "$expected_current_id"
    exit 0
  fi
  # Recover a retry after current was switched but previous was not.
  [[ "$previous_target" == "$target" ]] || sgx_die 'rollback state does not match the requested target/current pair'
  sgx_atomic_symlink "$expected_current" previous
  printf '%s rollback repair: current=%s previous=%s\n' "$([[ "$SGX_DRY_RUN" == '1' ]] && printf 'would complete' || printf 'completed')" "$target_id" "$expected_current_id"
  exit 0
fi

[[ "$current_target" == "$expected_current" ]] || sgx_die 'current release does not match expected-current-sha'
[[ "$previous_target" == "$target" ]] || sgx_die 'previous release does not match target-sha'

# The explicit expected-current argument makes a retry able to repair the
# second link if interruption occurs between these two atomic replacements.
sgx_atomic_symlink "$target" current
sgx_atomic_symlink "$expected_current" previous

printf '%s rollback: current=%s previous=%s\n' "$([[ "$SGX_DRY_RUN" == '1' ]] && printf 'would perform' || printf 'performed')" "$target_id" "$expected_current_id"
