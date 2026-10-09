#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=/gemini/code/sgx-classification
RUNTIME=/quota/sgx-classification
release="${1:?usage: start.sh <full-git-sha>}"
[[ "$release" =~ ^[0-9a-f]{40}$ ]] || { echo RELEASE_INVALID >&2; exit 2; }
[[ "$(readlink -f "$ROOT/current")" == "$ROOT/releases/$release" ]] || { echo RELEASE_NOT_ACTIVE >&2; exit 2; }
mkdir -p "$RUNTIME/runs" "$ROOT/shared/logs"
pidfile="$RUNTIME/runs/direct-supervisor.pid"
if [[ -f "$pidfile" ]]; then
  pid="$(<"$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    if [[ "$(tr '\0' ' ' <"/proc/$pid/cmdline")" == *"classification-api/bin/supervise.py --release $release"* ]]; then
      printf 'supervisor_pid=%s already_running=true\n' "$pid"
      exit 0
    fi
    echo SUPERVISOR_PID_MISMATCH >&2; exit 3
  fi
fi
log="$ROOT/shared/logs/direct-supervisor-$release-$(date -u +%Y%m%dT%H%M%SZ).log"
nohup /usr/bin/python3 "$ROOT/current/classification-api/bin/supervise.py" --release "$release" </dev/null >"$log" 2>&1 &
pid=$!
sleep 1
kill -0 "$pid" 2>/dev/null || { echo SUPERVISOR_START_FAILED >&2; exit 4; }
printf 'supervisor_pid=%s already_running=false\n' "$pid"
