#!/usr/bin/env bash

set -euo pipefail
umask 077

ROOT="${SGX_DEPLOY_ROOT:-/gemini/code/sgx-classification}"
RUNTIME="${SGX_RUNTIME_ROOT:-/quota/sgx-classification}"
EXPECTED_RELEASE="${SGX_EXPECTED_RELEASE:?SGX_EXPECTED_RELEASE is required}"
NODE="${SGX_WORKER_NODE:-$ROOT/shared/runtimes/node-v22.22.1-linux-x64/bin/node}"
PID_FILE="$RUNTIME/runs/worker.pid"
LOG="$ROOT/shared/logs/worker-$EXPECTED_RELEASE.log"

[[ "$(readlink -f "$ROOT/current")" == "$ROOT/releases/$EXPECTED_RELEASE" ]] || {
  echo CURRENT_RELEASE_MISMATCH >&2
  exit 2
}
[[ -x "$NODE" ]] || { echo NODE_RUNTIME_MISSING >&2; exit 2; }
[[ -r "$ROOT/shared/config/nonsecret.env" ]] || { echo NONSECRET_ENV_MISSING >&2; exit 2; }

mkdir -p "$RUNTIME/runs" "$ROOT/shared/logs" /tmp/sgx-classification/jobs
if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if kill -0 "$old_pid" 2>/dev/null; then
    printf 'worker_pid=%s already_running=true\n' "$old_pid"
    exit 0
  fi
  mv "$PID_FILE" "$PID_FILE.stale.$old_pid"
fi

set -a
# shellcheck disable=SC1091
. "$ROOT/shared/config/nonsecret.env"
set +a

# Secrets must already be present in this process environment. This script
# neither reads nor persists them.
: "${SGX_CONTROL_PLANE_TOKEN:?SGX_CONTROL_PLANE_TOKEN is required}"
if [[ "${SGX_PROCESSOR_MODE:-stage_a}" == "stage_a" && "${SGX_VLM_PROVIDER_MODE:-stage_a_real}" == "stage_a_real" ]]; then
  : "${SGX_D4_API_KEY:?SGX_D4_API_KEY is required for the real provider}"
fi

nohup "$NODE" "$ROOT/current/worker/runtime/main.mjs" </dev/null >"$LOG" 2>&1 &
child=$!
printf '%s\n' "$child" >"$PID_FILE"
chmod 600 "$PID_FILE" "$LOG"
sleep 0.5
if ! kill -0 "$child" 2>/dev/null; then
  echo WORKER_EXITED >&2
  tail -n 120 "$LOG" >&2
  exit 3
fi
printf 'worker_pid=%s already_running=false\n' "$child"
