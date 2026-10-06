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
[[ "$#" -eq 0 ]] || sgx_die 'usage: init-layout.sh [--dry-run]'

paths=(
  "$SGX_ROOT"
  "$SGX_ROOT/releases"
  "$SGX_ROOT/shared"
  "$SGX_ROOT/shared/cache"
  "$SGX_ROOT/shared/cache/huggingface"
  "$SGX_ROOT/shared/cache/huggingface/hub"
  "$SGX_ROOT/shared/cache/huggingface/transformers"
  "$SGX_ROOT/shared/cache/modelscope"
  "$SGX_ROOT/shared/cache/onnx"
  "$SGX_ROOT/shared/cache/torch"
  "$SGX_ROOT/shared/cache/pip"
  "$SGX_ROOT/shared/cache/uv"
  "$SGX_ROOT/shared/cache/xdg"
  "$SGX_ROOT/shared/cache/virtualenv"
  "$SGX_ROOT/shared/config"
  "$SGX_ROOT/shared/downloads"
  "$SGX_ROOT/shared/logs"
  "$SGX_ROOT/shared/manifests"
  "$SGX_ROOT/shared/models"
  "$SGX_ROOT/shared/wheelhouse"
  "$SGX_ROOT/shared/tools"
  "$SGX_ROOT/staging"
  "$SGX_ROOT/staging/models"
  "$SGX_ROOT/staging/packages"
  "$SGX_RUNTIME_ROOT"
  "$SGX_RUNTIME_ROOT/venvs"
  "$SGX_RUNTIME_ROOT/cache"
  "$SGX_RUNTIME_ROOT/cache/compiled"
  "$SGX_RUNTIME_ROOT/cache/generated"
  "$SGX_RUNTIME_ROOT/runs"
  "$SGX_RUNTIME_ROOT/locks"
  "$SGX_RUNTIME_ROOT/staging"
  "$SGX_SCRATCH_ROOT"
  "$SGX_SCRATCH_ROOT/jobs"
)

for path in "${paths[@]}"; do
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || sgx_die "refusing unsafe layout component: $path"
  fi
  if [[ "$SGX_DRY_RUN" == '1' ]]; then
    printf 'DRY-RUN ensure-directory %s mode=0700\n' "$path"
  else
    mkdir -p "$path"
    chmod 0700 "$path"
  fi
done

printf '%s persistent layout: %s\n' "$([[ "$SGX_DRY_RUN" == '1' ]] && printf 'validated' || printf 'initialized')" "$SGX_ROOT"
printf '%s runtime layout: %s\n' "$([[ "$SGX_DRY_RUN" == '1' ]] && printf 'validated' || printf 'initialized')" "$SGX_RUNTIME_ROOT"
printf '%s scratch layout: %s\n' "$([[ "$SGX_DRY_RUN" == '1' ]] && printf 'validated' || printf 'initialized')" "$SGX_SCRATCH_ROOT"
