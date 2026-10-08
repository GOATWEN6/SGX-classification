#!/usr/bin/env bash

# Start the local feature service and, only when explicitly requested, the
# pull-based Worker. This is an operator entrypoint, not a supervisor.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

usage() {
  cat >&2 <<'USAGE'
usage: start-stack.sh --release <full-40-character-git-sha> [--worker]

Starts the localhost Feature Service and verifies /healthz and /readyz. The
Worker is started only when --worker is present and the product control plane
has been configured with HTTPS and an injected SGX_CONTROL_PLANE_TOKEN.
USAGE
  exit 2
}

release=''
start_worker=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --release)
      [[ "$#" -ge 2 ]] || usage
      release="$2"
      shift 2
      ;;
    --worker)
      start_worker=1
      shift
      ;;
    *) usage ;;
  esac
done

[[ "$release" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'ERROR: --release must be a full 40-character lowercase Git SHA\n' >&2
  exit 2
}

# Resolve the fixed deployment root in a subshell. The library's readonly
# SGX_RUNTIME_ROOT must not conflict with the reviewed nonsecret.env below.
ROOT="$(
  # shellcheck source=layout-lib.sh
  source "$SCRIPT_DIR/layout-lib.sh"
  sgx_require_layout
  sgx_require_verified_release "$release"
  printf '%s\n' "$SGX_ROOT"
)"
CONFIG="$ROOT/shared/config/nonsecret.env"
[[ -r "$CONFIG" ]] || { printf 'ERROR: NONSECRET_ENV_MISSING\n' >&2; exit 3; }

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

export SGX_EXPECTED_RELEASE="$release"
"$PACKAGE_ROOT/bin/start-feature-service.sh"

SGX_STARTUP_EXPECTED_RELEASE="$release" python3 - <<'PY'
import json
import os
import urllib.error
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
for endpoint in ("healthz", "version", "readyz"):
    try:
        with opener.open(f"http://127.0.0.1:8765/{endpoint}", timeout=5) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        if endpoint == "readyz" and error.code == 503:
            payload = json.load(error)
            states = {name: value.get("status", "unknown") for name, value in payload.get("components", {}).items()}
            print(f"feature_service_readyz=not_ready components={json.dumps(states, sort_keys=True)}")
            raise SystemExit("FEATURE_SERVICE_NOT_READY: warm enabled models with tools/warm-feature-service.py before starting Worker")
        raise SystemExit(f"FEATURE_SERVICE_{endpoint.upper()}_HTTP_{error.code}") from None
    except (OSError, ValueError):
        raise SystemExit(f"FEATURE_SERVICE_{endpoint.upper()}_UNAVAILABLE") from None
    if endpoint == "version" and payload.get("gitCommit") != os.environ["SGX_STARTUP_EXPECTED_RELEASE"]:
        raise SystemExit("FEATURE_SERVICE_VERSION_MISMATCH")
    print(f"feature_service_{endpoint}=ok release_id={payload.get('releaseId', 'unknown')}")
PY

if [[ "$start_worker" != '1' ]]; then
  printf 'worker=not_started reason=control_plane_not_requested\n'
  exit 0
fi

control_plane="${SGX_CONTROL_PLANE_BASE_URL:-}"
[[ "$control_plane" == https://* ]] || {
  printf 'ERROR: SGX_CONTROL_PLANE_BASE_URL must be a real HTTPS product backend when --worker is used\n' >&2
  exit 4
}
[[ "$control_plane" != *replace-with-product-backend* ]] || {
  printf 'ERROR: SGX_CONTROL_PLANE_BASE_URL is still a placeholder\n' >&2
  exit 4
}
[[ -n "${SGX_CONTROL_PLANE_TOKEN:-}" ]] || {
  printf 'ERROR: SGX_CONTROL_PLANE_TOKEN must be injected by the secret store when --worker is used\n' >&2
  exit 4
}

# Check transport and route existence without leasing a job or sending secrets.
python3 - <<'PY'
import os
import urllib.error
import urllib.parse
import urllib.request

base = os.environ["SGX_CONTROL_PLANE_BASE_URL"]
url = urllib.parse.urlsplit(base)
if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
    raise SystemExit("CONTROL_PLANE_URL_INVALID")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
routes = ["/internal/v1/classification/leases"]
if os.environ.get("SGX_ASR_PREJOB_ENABLED") == "true":
    routes.append("/internal/v1/classification/asr/leases")
for route in routes:
    try:
        with opener.open(urllib.request.Request(base.rstrip("/") + route, method="HEAD"), timeout=5) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    except (OSError, ValueError):
        raise SystemExit("CONTROL_PLANE_UNREACHABLE") from None
    if status not in (200, 204, 401, 403, 405):
        raise SystemExit(f"CONTROL_PLANE_ROUTE_UNAVAILABLE:HTTP_{status}")
print("control_plane_transport=reachable authentication_and_protocol=unverified")
PY

"$PACKAGE_ROOT/bin/start-worker.sh"
printf 'worker=started control_plane=configured\n'
