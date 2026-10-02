#!/usr/bin/env bash
set -u

# Read-only VirtAI inventory for SGX classification deployment.
# This script intentionally does not install packages, create directories, or print environment variables.

section() {
  printf '\n[%s]\n' "$1"
}

safe_command() {
  local label="$1"
  shift
  printf '%s: ' "$label"
  if command -v "$1" >/dev/null 2>&1; then
    "$@" 2>&1 || true
  else
    printf 'NOT_FOUND\n'
  fi
}

section identity
printf 'timestamp_utc: '
date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true
printf 'hostname: '
hostname 2>/dev/null || true
printf 'user: '
id -un 2>/dev/null || true
printf 'uid_gid: '
id 2>/dev/null || true
printf 'kernel: '
uname -a 2>/dev/null || true

section compute
safe_command cpu_count getconf _NPROCESSORS_ONLN
safe_command cpu_summary lscpu
safe_command memory free -h
safe_command gpu nvidia-smi

section runtimes
safe_command python3 python3 --version
safe_command pip3 pip3 --version
safe_command node node --version
safe_command npm npm --version
safe_command git git --version
safe_command docker docker --version
safe_command ffmpeg ffmpeg -version

section cuda
safe_command nvcc nvcc --version
for candidate in /usr/local/cuda /usr/local/cuda-*; do
  if [ -e "$candidate" ]; then
    printf 'cuda_path: %s\n' "$candidate"
  fi
done

section storage
safe_command disk_free df -h
for path in /gemini/code /gemini/output /gemini/data-1 /gemini/data-2 /gemini/data-3 /gemini/pretrain /gemini/pretrain2 /gemini/pretrain3; do
  if [ -e "$path" ]; then
    readable=no
    writable=no
    [ -r "$path" ] && readable=yes
    [ -w "$path" ] && writable=yes
    printf 'mount path=%s exists=yes readable=%s writable=%s\n' "$path" "$readable" "$writable"
  else
    printf 'mount path=%s exists=no\n' "$path"
  fi
done

section existing_model_roots
for path in /gemini/pretrain /gemini/pretrain2 /gemini/pretrain3; do
  if [ -d "$path" ]; then
    printf 'root: %s\n' "$path"
    find "$path" -mindepth 1 -maxdepth 2 -type d -print 2>/dev/null | head -n 200
  fi
done

section python_packages
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
from importlib.metadata import PackageNotFoundError, version

for package in (
    "torch",
    "torchvision",
    "transformers",
    "onnxruntime",
    "onnxruntime-gpu",
    "rapidocr",
    "rapidocr-onnxruntime",
    "paddleocr",
    "paddlepaddle",
    "fastapi",
    "uvicorn",
    "psycopg",
):
    try:
        print(f"{package}: {version(package)}")
    except PackageNotFoundError:
        print(f"{package}: NOT_INSTALLED")
PY
fi

section result
printf 'preflight_complete: yes\n'
printf 'mutation_performed: no\n'
