#!/usr/bin/env python3
"""Read-only SGX deployment diagnosis; never prints config values or raw logs."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def config_values(path: Path) -> dict[str, str]:
    # Parse literal reviewed settings; do not execute shell or read secret files.
    allowed = {"SGX_CONTROL_PLANE_BASE_URL", "SGX_PROCESSOR_MODE", "SGX_VLM_PROVIDER_MODE"}
    if not path.is_file() or path.is_symlink():
        return {}
    result = {}
    for line in path.read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and name in allowed:
            result[name] = value.strip().strip("\"'")
    return result


def process_status(pid_file: Path, identity: str) -> str:
    if not pid_file.is_file() or pid_file.is_symlink():
        return "not_started"
    try:
        pid = int(pid_file.read_text().strip())
        if pid <= 1:
            return "invalid_pid"
        os.kill(pid, 0)
        proc = Path("/proc") / str(pid)
        if proc.exists():
            if proc.joinpath("stat").read_text().split(") ", 1)[1].split()[0] == "Z":
                return "stale_pid"
            if identity not in proc.joinpath("cmdline").read_bytes().decode(errors="replace"):
                return "pid_identity_mismatch"
        return "running"
    except (OSError, ValueError, IndexError):
        return "stale_pid"


def feature_status(opener, endpoint: str) -> dict:
    try:
        with opener.open("http://127.0.0.1:8765/" + endpoint, timeout=3) as response:
            payload = json.loads(response.read(65536))
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            payload = json.loads(exc.read(65536))
        except (ValueError, OSError):
            payload = {}
    except (OSError, ValueError):
        return {"status": "unavailable"}
    result = {"httpStatus": status}
    for key in ("status", "gitCommit", "releaseId", "serviceVersion"):
        if isinstance(payload.get(key), str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", payload[key]):
            result[key] = payload[key]
    if endpoint == "readyz":
        result["components"] = {
            name: {key: value[key] for key in ("status", "loaded", "errorCode") if key in value}
            for name, value in payload.get("components", {}).items()
            if name in {"jobTmpRoot", "ocr", "imageEmbedding", "textEmbedding", "faceEmbedding", "asr"}
            and isinstance(value, dict)
        }
    return result


def main() -> int:
    root, runtime = map(Path, sys.argv[1:])
    config = config_values(root / "shared/config/nonsecret.env")
    report = {"schemaVersion": "classification-stack-status.1", "publicAlgorithmEndpoint": None}
    for name in ("current", "previous"):
        link = root / name
        target = os.readlink(link) if link.is_symlink() else ""
        if re.fullmatch(r"releases/[0-9a-f]{40}", target):
            directory = root / target
            marker = directory / "VERIFIED"
            report[name] = {"release": target.removeprefix("releases/"),
                            "verified": marker.is_file() and not marker.is_symlink()
                            and not directory.is_symlink()}
        else:
            report[name] = {"status": "missing_or_unsafe"}
    report["featureProcess"] = process_status(runtime / "runs/feature-service.pid", "sgx_classification_feature_service")
    report["workerProcess"] = process_status(runtime / "runs/worker.pid", "/worker/runtime/main.mjs")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    report["feature"] = {name: feature_status(opener, name) for name in ("healthz", "readyz", "version")}
    plane = config.get("SGX_CONTROL_PLANE_BASE_URL", "")
    try:
        parsed = urllib.parse.urlsplit(plane)
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if not plane or "replace-with" in plane or parsed.hostname in {None, "product.example.test"}:
            state = "not_configured"
        elif parsed.username or parsed.password or parsed.query or parsed.fragment or not (
            parsed.scheme == "https" or (local and parsed.scheme == "http")
        ):
            state = "invalid_url"
        else:
            # HEAD without credentials cannot lease a job or invoke a model.
            try:
                with opener.open(urllib.request.Request(plane.rstrip("/") + "/internal/v1/classification/leases", method="HEAD"), timeout=3) as response:
                    status = response.status
            except urllib.error.HTTPError as exc:
                status = exc.code
            state = "reachable_http_contract_unverified" if status in (200, 204, 401, 403, 405) else "control_plane_route_unavailable"
            report["controlPlaneHttpStatus"] = status
        report["controlPlane"] = {"status": state, "developmentLoopback": local}
    except (OSError, ValueError):
        report["controlPlane"] = {"status": "control_plane_unreachable"}
    # Environment presence only: no /proc/environ or credential files.
    report["operatorSecretEnvironment"] = {
        key: bool(os.environ.get(key)) for key in ("SGX_CONTROL_PLANE_TOKEN", "SGX_D4_API_KEY")
    }
    log = root / "shared/logs" / ("worker-" + report["current"].get("release", "unknown") + ".log")
    events = []
    if log.is_file() and not log.is_symlink():
        with log.open("rb") as handle:
            handle.seek(max(0, log.stat().st_size - 65536))
            for line in handle.read().splitlines():
                try:
                    entry = json.loads(line)
                    if entry.get("event") in {"lease_poll_failed", "asr_lease_poll_failed", "job_failed", "worker_stopped", "job_completed"}:
                        events.append({key: entry[key] for key in ("timestamp", "event", "errorCode", "stage") if key in entry})
                except (ValueError, AttributeError):
                    pass
    report["recentLogEvents"] = events[-4:]
    issues = []
    if not report["current"].get("verified"):
        issues.append("release_unverified")
    if report["feature"]["readyz"].get("status") != "ready":
        issues.append("feature_service_not_ready")
    if report["feature"]["version"].get("gitCommit") != report["current"].get("release"):
        issues.append("feature_service_version_mismatch")
    if report["controlPlane"]["status"] != "reachable_http_contract_unverified":
        issues.append(report["controlPlane"]["status"])
    if report["workerProcess"] != "running":
        issues.append("worker_not_running")
    report["issues"] = issues
    # Recent logs do not establish empty queue, valid credentials, or full pipeline readiness.
    report["workerTaskContractVerified"] = False
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
