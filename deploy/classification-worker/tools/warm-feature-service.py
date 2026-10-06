#!/usr/bin/env python3
"""Warm every enabled loopback feature capability with local frozen fixtures."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request_json(base_url: str, route: str, source: Path | None = None) -> tuple[int, dict]:
    body = None
    headers: dict[str, str] = {}
    if source is not None:
        body = json.dumps(
            {
                "sourcePath": str(source),
                "sourceSha256": sha256(source),
                "sourceByteLength": source.stat().st_size,
            }
        ).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        base_url + route,
        data=body,
        headers=headers,
        method="POST" if source is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--job-root", type=Path, default=Path("/tmp/sgx-classification/jobs"))
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--face-image", type=Path, required=True)
    parser.add_argument("--text", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    sources = {
        "ocr": ("/internal/v1/features/ocr", args.image),
        "imageEmbedding": ("/internal/v1/features/image-embedding", args.image),
        "textEmbedding": ("/internal/v1/features/text-embedding", args.text),
        "faceEmbedding": ("/internal/v1/features/face-embeddings", args.face_image),
        "asr": ("/internal/v1/features/asr", args.audio),
    }
    for _, source in sources.values():
        source.resolve(strict=True)
    args.job_root.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="feature-warm-", dir=args.job_root))
    checks: dict[str, dict[str, object]] = {}
    try:
        for name, (route, source) in sources.items():
            local_source = workdir / source.name
            shutil.copy2(source, local_source)
            status, payload = request_json(args.base_url, route, local_source)
            if status != 200:
                raise RuntimeError(f"{name.upper()}_WARM_FAILED:{status}")
            checks[name] = {
                "status": status,
                "modelId": payload.get("modelId"),
                "dimensions": payload.get("dimensions"),
                "regionCount": len(payload.get("regions", [])),
                "faceCount": len(payload.get("faces", [])),
                "textNonempty": bool(str(payload.get("text", "")).strip()),
            }
        status, ready = request_json(args.base_url, "/readyz")
        if status != 200 or ready.get("status") != "ready":
            raise RuntimeError("FEATURE_SERVICE_NOT_READY_AFTER_WARM")
        print(json.dumps({"status": "ready", "checks": checks}, ensure_ascii=False))
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
