#!/usr/bin/env bash

set -euo pipefail
umask 077

ROOT="${SGX_DEPLOY_ROOT:-/gemini/code/sgx-classification}"
RUNTIME="${SGX_RUNTIME_ROOT:-/quota/sgx-classification}"
PYTHON="${SGX_FEATURE_PYTHON:-$RUNTIME/venvs/feature-service-all-py310-20261003-r2/bin/python}"
EXPECTED_RELEASE="${SGX_EXPECTED_RELEASE:?SGX_EXPECTED_RELEASE is required}"
PID_FILE="$RUNTIME/runs/feature-service.pid"
LOG="$ROOT/shared/logs/feature-service-$EXPECTED_RELEASE.log"

[[ "$(readlink -f "$ROOT/current")" == "$ROOT/releases/$EXPECTED_RELEASE" ]] || {
  echo CURRENT_RELEASE_MISMATCH >&2
  exit 2
}
[[ -x "$PYTHON" ]] || { echo PYTHON_RUNTIME_MISSING >&2; exit 2; }
[[ -r "$ROOT/shared/config/nonsecret.env" ]] || { echo NONSECRET_ENV_MISSING >&2; exit 2; }

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if kill -0 "$old_pid" 2>/dev/null; then
    if "$PYTHON" - <<'PY' >/dev/null 2>&1
import urllib.request
with urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=2) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
    then
      printf 'feature_service_pid=%s already_running=true\n' "$old_pid"
      exit 0
    fi
    echo FEATURE_SERVICE_PID_ALIVE_BUT_UNHEALTHY >&2
    exit 3
  fi
  mv "$PID_FILE" "$PID_FILE.stale.$old_pid"
fi

set -a
# shellcheck disable=SC1091
. "$ROOT/shared/config/nonsecret.env"
set +a
export PYTHONPATH="$ROOT/current/feature-service/src"
mkdir -p "$RUNTIME/runs" "$ROOT/shared/logs" /tmp/sgx-classification/jobs

nohup "$PYTHON" -m sgx_classification_feature_service </dev/null >"$LOG" 2>&1 &
child=$!
printf '%s\n' "$child" >"$PID_FILE"
chmod 600 "$PID_FILE" "$LOG"

for _ in $(seq 1 60); do
  if ! kill -0 "$child" 2>/dev/null; then
    echo FEATURE_SERVICE_EXITED >&2
    tail -n 120 "$LOG" >&2
    exit 4
  fi
  if "$PYTHON" - <<'PY' >/dev/null 2>&1
import urllib.request
with urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=2) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
  then
    printf 'feature_service_pid=%s already_running=false\n' "$child"
    exit 0
  fi
  sleep 0.5
done

echo FEATURE_SERVICE_HEALTH_TIMEOUT >&2
tail -n 120 "$LOG" >&2
exit 5
