#!/usr/bin/env bash

# Shared fail-closed helpers for the SGX classification worker deployment.
# This file performs no writes when sourced.

set -euo pipefail

readonly SGX_PRODUCTION_PERSISTENT_ROOT='/gemini/code/sgx-classification'
readonly SGX_PRODUCTION_RUNTIME_ROOT='/quota/sgx-classification'
readonly SGX_PRODUCTION_SCRATCH_ROOT='/tmp/sgx-classification'

sgx_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sgx_canonical_path() {
  python3 - "$1" <<'PY'
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
}

sgx_resolve_root() {
  local kind="$1" candidate canonical temporary_root expected suffix
  if [[ "${SGX_DEPLOY_TEST_MODE:-0}" == '1' ]]; then
    case "$kind" in
      persistent)
        candidate="${SGX_CLASSIFICATION_TEST_ROOT:-}"
        suffix='/persistent/sgx-classification'
        ;;
      runtime)
        candidate="${SGX_CLASSIFICATION_RUNTIME_TEST_ROOT:-}"
        suffix='/runtime/sgx-classification'
        ;;
      scratch)
        candidate="${SGX_CLASSIFICATION_SCRATCH_TEST_ROOT:-}"
        suffix='/tmp/sgx-classification'
        ;;
      *) sgx_die "unsupported root kind: $kind" ;;
    esac
    [[ -n "$candidate" ]] || sgx_die "test root is required for $kind"
    canonical="$(sgx_canonical_path "$candidate")"
    temporary_root="$(sgx_canonical_path "${TMPDIR:-/tmp}")"
    case "$canonical" in
      "$temporary_root"/sgx-classification-fixture.*"$suffix") ;;
      *) sgx_die "test $kind root must be a dedicated sgx-classification-fixture.* path below TMPDIR" ;;
    esac
  else
    [[ -z "${SGX_CLASSIFICATION_TEST_ROOT:-}" ]] || sgx_die 'persistent test root override is forbidden outside test mode'
    [[ -z "${SGX_CLASSIFICATION_RUNTIME_TEST_ROOT:-}" ]] || sgx_die 'runtime test root override is forbidden outside test mode'
    [[ -z "${SGX_CLASSIFICATION_SCRATCH_TEST_ROOT:-}" ]] || sgx_die 'scratch test root override is forbidden outside test mode'
    case "$kind" in
      persistent) expected="$SGX_PRODUCTION_PERSISTENT_ROOT" ;;
      runtime) expected="$SGX_PRODUCTION_RUNTIME_ROOT" ;;
      scratch) expected="$SGX_PRODUCTION_SCRATCH_ROOT" ;;
      *) sgx_die "unsupported root kind: $kind" ;;
    esac
    candidate="$expected"
    canonical="$(sgx_canonical_path "$candidate")"
    [[ "$canonical" == "$expected" ]] || sgx_die "production $kind root resolves outside $expected"
  fi
  printf '%s\n' "$canonical"
}

SGX_ROOT="$(sgx_resolve_root persistent)"
SGX_RUNTIME_ROOT="$(sgx_resolve_root runtime)"
SGX_SCRATCH_ROOT="$(sgx_resolve_root scratch)"
readonly SGX_ROOT
readonly SGX_RUNTIME_ROOT
readonly SGX_SCRATCH_ROOT

sgx_require_release_id() {
  local release_id="${1:-}"
  [[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || sgx_die 'release id must be a full 40-character lowercase Git SHA'
}

sgx_require_plain_directory() {
  local path="$1"
  [[ -d "$path" ]] || sgx_die "required directory is missing: $path"
  [[ ! -L "$path" ]] || sgx_die "managed directory must not be a symlink: $path"
}

sgx_require_layout() {
  local path
  for path in \
    "$SGX_ROOT" \
    "$SGX_ROOT/releases" \
    "$SGX_ROOT/shared" \
    "$SGX_ROOT/shared/cache" \
    "$SGX_ROOT/shared/cache/huggingface" \
    "$SGX_ROOT/shared/cache/huggingface/hub" \
    "$SGX_ROOT/shared/cache/huggingface/transformers" \
    "$SGX_ROOT/shared/cache/modelscope" \
    "$SGX_ROOT/shared/cache/onnx" \
    "$SGX_ROOT/shared/cache/torch" \
    "$SGX_ROOT/shared/cache/pip" \
    "$SGX_ROOT/shared/cache/uv" \
    "$SGX_ROOT/shared/cache/xdg" \
    "$SGX_ROOT/shared/cache/virtualenv" \
    "$SGX_ROOT/shared/config" \
    "$SGX_ROOT/shared/downloads" \
    "$SGX_ROOT/shared/manifests" \
    "$SGX_ROOT/shared/models" \
    "$SGX_ROOT/shared/wheelhouse" \
    "$SGX_ROOT/shared/tools" \
    "$SGX_ROOT/staging" \
    "$SGX_ROOT/staging/models" \
    "$SGX_ROOT/staging/packages" \
    "$SGX_RUNTIME_ROOT" \
    "$SGX_RUNTIME_ROOT/venvs" \
    "$SGX_RUNTIME_ROOT/cache" \
    "$SGX_RUNTIME_ROOT/cache/compiled" \
    "$SGX_RUNTIME_ROOT/cache/generated" \
    "$SGX_RUNTIME_ROOT/runs" \
    "$SGX_RUNTIME_ROOT/locks" \
    "$SGX_RUNTIME_ROOT/staging" \
    "$SGX_SCRATCH_ROOT" \
    "$SGX_SCRATCH_ROOT/jobs"; do
    sgx_require_plain_directory "$path"
  done
}

sgx_release_dir() {
  local release_id="$1" expected resolved
  sgx_require_release_id "$release_id"
  expected="$SGX_ROOT/releases/$release_id"
  resolved="$(sgx_canonical_path "$expected")"
  [[ "$resolved" == "$expected" ]] || sgx_die "release path resolves outside the managed releases directory: $release_id"
  printf '%s\n' "$expected"
}

sgx_require_verified_release() {
  local release_id="$1" release_dir marker
  release_dir="$(sgx_release_dir "$release_id")"
  sgx_require_plain_directory "$release_dir"
  marker="$release_dir/VERIFIED"
  [[ -f "$marker" && ! -L "$marker" ]] || sgx_die "release is missing a regular VERIFIED marker: $release_id"
}

sgx_validate_release_target() {
  local target="$1" release_id
  [[ "$target" =~ ^releases/([0-9a-f]{40})$ ]] || sgx_die "managed link has an unsafe target: $target"
  release_id="${target#releases/}"
  sgx_require_verified_release "$release_id"
}

sgx_read_managed_link() {
  local name="$1" path target
  [[ "$name" == 'current' || "$name" == 'previous' ]] || sgx_die "unsupported managed link: $name"
  path="$SGX_ROOT/$name"
  [[ -L "$path" ]] || sgx_die "managed link is missing or is not a symlink: $path"
  target="$(readlink "$path")"
  sgx_validate_release_target "$target"
  printf '%s\n' "$target"
}

sgx_link_exists() {
  local name="$1" path="$SGX_ROOT/$1"
  [[ "$name" == 'current' || "$name" == 'previous' ]] || sgx_die "unsupported managed link: $name"
  [[ -e "$path" || -L "$path" ]]
}

sgx_atomic_symlink() {
  local target="$1" name="$2" path temporary
  [[ "$name" == 'current' || "$name" == 'previous' ]] || sgx_die "unsupported managed link: $name"
  sgx_validate_release_target "$target"
  path="$SGX_ROOT/$name"
  [[ ! -e "$path" || -L "$path" ]] || sgx_die "refusing to replace a non-symlink path: $path"
  if [[ "${SGX_DRY_RUN:-0}" == '1' ]]; then
    printf 'DRY-RUN atomic-link %s -> %s\n' "$name" "$target"
    return
  fi
  temporary="$SGX_ROOT/.${name}.tmp.$$.${RANDOM}"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || sgx_die "temporary link already exists: $temporary"
  ln -s "$target" "$temporary"
  if ! python3 - "$temporary" "$path" <<'PY'
import os
import sys

source, destination = sys.argv[1:]
if os.path.isdir(destination) and not os.path.islink(destination):
    raise SystemExit('refusing to replace a directory')
os.replace(source, destination)
PY
  then
    rm -f "$temporary"
    sgx_die "failed to atomically replace $name"
  fi
}
