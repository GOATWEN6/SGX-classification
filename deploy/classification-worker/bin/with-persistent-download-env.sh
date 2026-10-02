#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=layout-lib.sh
source "$SCRIPT_DIR/layout-lib.sh"

[[ "$#" -gt 0 ]] || sgx_die 'usage: with-persistent-download-env.sh command [args...]'
sgx_require_layout

# Every cache that can retain bytes obtained from the network lives below the
# persistent SGX root. /quota is reserved for unpacked, offline-rebuildable
# environments and generated runtime data; /tmp remains per-job scratch only.
export SGX_PERSISTENCE_POLICY_VERSION='classification-download-persistence.1'
export SGX_MODEL_CACHE_ROOT="$SGX_ROOT/shared/cache"
export SGX_MODEL_ROOT="$SGX_ROOT/shared/models/candidates"
export SGX_WHEELHOUSE_ROOT="$SGX_ROOT/shared/wheelhouse"
export SGX_DOWNLOAD_ROOT="$SGX_ROOT/shared/downloads"
export HF_HOME="$SGX_ROOT/shared/cache/huggingface"
export HF_HUB_CACHE="$SGX_ROOT/shared/cache/huggingface/hub"
export HUGGINGFACE_HUB_CACHE="$SGX_ROOT/shared/cache/huggingface/hub"
export TRANSFORMERS_CACHE="$SGX_ROOT/shared/cache/huggingface/transformers"
export MODELSCOPE_CACHE="$SGX_ROOT/shared/cache/modelscope"
export SGX_ONNX_CACHE="$SGX_ROOT/shared/cache/onnx"
export TORCH_HOME="$SGX_ROOT/shared/cache/torch"
export PIP_CACHE_DIR="$SGX_ROOT/shared/cache/pip"
export UV_CACHE_DIR="$SGX_ROOT/shared/cache/uv"
export XDG_CACHE_HOME="$SGX_ROOT/shared/cache/xdg"
export VIRTUALENV_OVERRIDE_APP_DATA="$SGX_ROOT/shared/cache/virtualenv"

for name in \
  SGX_MODEL_CACHE_ROOT \
  SGX_MODEL_ROOT \
  SGX_WHEELHOUSE_ROOT \
  SGX_DOWNLOAD_ROOT \
  HF_HOME \
  HF_HUB_CACHE \
  HUGGINGFACE_HUB_CACHE \
  TRANSFORMERS_CACHE \
  MODELSCOPE_CACHE \
  SGX_ONNX_CACHE \
  TORCH_HOME \
  PIP_CACHE_DIR \
  UV_CACHE_DIR \
  XDG_CACHE_HOME \
  VIRTUALENV_OVERRIDE_APP_DATA; do
  value="${!name}"
  canonical="$(sgx_canonical_path "$value")"
  case "$canonical" in
    "$SGX_ROOT"/*) ;;
    *) sgx_die "$name must stay below the persistent SGX root" ;;
  esac
done

exec "$@"
