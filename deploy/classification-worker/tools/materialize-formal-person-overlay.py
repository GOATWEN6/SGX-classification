#!/usr/bin/env python3
"""Materialize anonymous person truth from the local SGX face service.

The tool makes no provider/paid-model calls.  It reads a prepared formal
campaign, invokes only the loopback feature service once per unique image,
keeps raw anonymous vectors in a fresh persistent run directory, and writes a
small overlay containing normalized boxes plus synthetic anonymous IDs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image


DATASET_DIGEST = "sha256:2d18d96933f5c85454357eedee45cb185c9ad5eefac6f21e513ce0166ded0f2a"
PERSISTENT_ROOT = Path("/gemini/code/sgx-classification")
REQUIRED = {
    "SGX-V2-E016": (1, ("anon-bamboo-bike-01",)),
    "SGX-V2-E017": (1, ("anon-bamboo-bike-01",)),
    "SGX-V2-E018": (1, ("anon-bamboo-bike-01",)),
    "SGX-V2-H008": (2, ("anon-river-travel-left", "anon-river-travel-right")),
    "SGX-V2-H009": (2, ("anon-river-travel-left", "anon-river-travel-right")),
    "SGX-V2-H010": (2, ("anon-river-h010-left", "anon-river-h010-right")),
}


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _write_new(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(_json_bytes(value))


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _request_json(endpoint: str, payload: dict[str, object], timeout: float) -> dict[str, object]:
    url = endpoint.rstrip("/") + "/internal/v1/features/face-embeddings"
    request = Request(url, data=_json_bytes(payload), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - loopback URL is validated by caller
            body = response.read()
            if response.status != 200:
                raise RuntimeError(f"FACE_SERVICE_HTTP_{response.status}")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"FACE_SERVICE_HTTP_{exc.code}:{body}") from exc
    except URLError as exc:
        raise RuntimeError("FACE_SERVICE_UNAVAILABLE") from exc
    value = json.loads(body)
    if not isinstance(value, dict):
        raise RuntimeError("FACE_SERVICE_INVALID_JSON")
    return value


def _load_photos(campaign_root: Path) -> list[dict[str, object]]:
    photos: dict[str, dict[str, object]] = {}
    for phase in ("exploration", "validation"):
        manifest = json.loads((campaign_root / "manifests" / f"{phase}.json").read_text("utf-8"))
        if manifest.get("datasetRootDigest") != DATASET_DIGEST:
            raise RuntimeError("CAMPAIGN_DATASET_MISMATCH")
        for item in manifest.get("photos", []):
            photo = item["photo"]
            photo_id = photo["photoId"]
            resolved = (campaign_root / "manifests" / item["path"]).resolve()
            if not _inside(campaign_root, resolved):
                raise RuntimeError("CAMPAIGN_IMAGE_PATH_ESCAPE")
            candidate = {"photoId": photo_id, "sourceHash": photo["sourceHash"], "path": resolved}
            previous = photos.get(photo_id)
            if previous and previous != candidate:
                raise RuntimeError("CAMPAIGN_DUPLICATE_PHOTO_DRIFT")
            photos[photo_id] = candidate
    if len(photos) != 30:
        raise RuntimeError(f"CAMPAIGN_IMAGE_DENOMINATOR_{len(photos)}")
    if not set(REQUIRED).issubset(photos):
        raise RuntimeError("PERSON_REQUIRED_PHOTOS_MISSING")
    return [photos[key] for key in sorted(photos)]


def _select_truth_faces(photo_id: str, response: dict[str, object], width: int, height: int) -> list[dict[str, object]]:
    count, person_ids = REQUIRED[photo_id]
    faces = response.get("faces")
    if not isinstance(faces, list) or len(faces) < count:
        raise RuntimeError(f"PERSON_FACE_COUNT_{photo_id}_{len(faces) if isinstance(faces, list) else 0}_{count}")
    selected = sorted(faces, key=lambda face: face["bounds"]["width"] * face["bounds"]["height"], reverse=True)[:count]
    selected.sort(key=lambda face: face["bounds"]["x"])
    result = []
    for face, person_id in zip(selected, person_ids, strict=True):
        bounds = face["bounds"]
        box = {
            "x": bounds["x"] / width,
            "y": bounds["y"] / height,
            "width": bounds["width"] / width,
            "height": bounds["height"] / height,
        }
        if box["x"] < 0 or box["y"] < 0 or box["width"] <= 0 or box["height"] <= 0 or box["x"] + box["width"] > 1 or box["y"] + box["height"] > 1:
            raise RuntimeError(f"PERSON_FACE_BOX_{photo_id}")
        result.append({"faceId": face["faceId"], "personId": person_id, "box": box})
    return result


def materialize(args: argparse.Namespace) -> dict[str, object]:
    campaign_root = Path(args.campaign_root).resolve()
    out_root = Path(args.out_root).resolve()
    scratch_root = Path(args.scratch_root).resolve()
    if not args.allow_ephemeral_test and not _inside(PERSISTENT_ROOT, out_root):
        raise RuntimeError("PERSISTENT_OUTPUT_REQUIRED")
    if out_root.exists():
        raise RuntimeError("OUTPUT_EXISTS")
    if not args.endpoint.startswith("http://127.0.0.1:") and not args.endpoint.startswith("http://localhost:"):
        raise RuntimeError("LOOPBACK_FEATURE_SERVICE_REQUIRED")
    photos = _load_photos(campaign_root)
    out_root.mkdir(parents=True, mode=0o700)
    raw_root = out_root / "raw"
    raw_root.mkdir(mode=0o700)
    scratch_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    entries = []
    ledger = []
    detector_identity = None
    embedding_identity = None
    try:
        for photo in photos:
            photo_id = str(photo["photoId"])
            source_path = Path(photo["path"])
            data = source_path.read_bytes()
            source_hash = _sha(data)
            if source_hash != photo["sourceHash"]:
                raise RuntimeError(f"PHOTO_HASH_MISMATCH_{photo_id}")
            job_dir = Path(tempfile.mkdtemp(prefix=f"person-{photo_id}-", dir=scratch_root))
            try:
                job_file = job_dir / "input.jpg"
                shutil.copyfile(source_path, job_file)
                response = _request_json(args.endpoint, {
                    "sourcePath": str(job_file),
                    "sourceSha256": source_hash.removeprefix("sha256:"),
                    "sourceByteLength": len(data),
                }, args.timeout_seconds)
            finally:
                shutil.rmtree(job_dir, ignore_errors=True)
            if response.get("sourceSha256") != source_hash.removeprefix("sha256:") or response.get("sourceByteLength") != len(data):
                raise RuntimeError(f"FACE_RESPONSE_SOURCE_MISMATCH_{photo_id}")
            raw_path = raw_root / f"{photo_id}.json"
            _write_new(raw_path, response)
            identity = (response.get("detectorModelId"), response.get("detectorModelRevision"))
            embedding = (response.get("embeddingModelId"), response.get("embeddingModelRevision"), response.get("dimensions"), response.get("normalized"))
            if detector_identity is None:
                detector_identity = identity
                embedding_identity = embedding
            if identity != detector_identity or embedding != embedding_identity:
                raise RuntimeError("FACE_MODEL_IDENTITY_DRIFT")
            faces = response.get("faces") if isinstance(response.get("faces"), list) else []
            ledger.append({"photoId": photo_id, "sourceHash": source_hash, "faceCount": len(faces), "rawPath": f"raw/{photo_id}.json", "rawHash": _sha(raw_path.read_bytes())})
            if photo_id in REQUIRED:
                with Image.open(source_path) as image:
                    width, height = image.size
                entries.append({"photoId": photo_id, "sourceHash": source_hash, "faces": _select_truth_faces(photo_id, response, width, height)})
        overlay = {
            "version": "sgx-formal-v2-person-overlay.1",
            "datasetRootDigest": DATASET_DIGEST,
            "generatedAt": args.generated_at,
            "reviewedBy": "synthetic-scenario-definition-plus-yunet-boxes",
            "detector": {"modelId": detector_identity[0], "modelRevision": detector_identity[1]},
            "embedding": {"modelId": embedding_identity[0], "modelRevision": embedding_identity[1], "dimensions": embedding_identity[2], "normalized": embedding_identity[3]},
            "entries": entries,
            "claimBoundary": "anonymous_synthetic_person_truth_only",
        }
        _write_new(out_root / "person-overlay.json", overlay)
        _write_new(out_root / "feature-ledger.json", {"version": "sgx-formal-v2-person-feature-ledger.1", "planned": 30, "completed": len(ledger), "failed": 0, "items": ledger})
        complete = {"version": "sgx-formal-v2-person-materialization-complete.1", "planned": 30, "completed": len(ledger), "failed": 0, "overlayHash": _sha((out_root / "person-overlay.json").read_bytes()), "ledgerHash": _sha((out_root / "feature-ledger.json").read_bytes())}
        _write_new(out_root / "COMPLETE.json", complete)
        return complete
    except Exception as exc:
        _write_new(out_root / "FAILED.json", {"version": "sgx-formal-v2-person-materialization-failure.1", "completed": len(ledger), "errorCode": str(exc)[:500], "items": ledger})
        raise


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign-root", required=True)
    parser.add_argument("--out-root", required=True)
    parser.add_argument("--scratch-root", default=os.environ.get("SGX_JOB_TMP_ROOT", "/tmp/sgx-classification/jobs"))
    parser.add_argument("--endpoint", default="http://127.0.0.1:8765")
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    parser.add_argument("--generated-at", required=True)
    parser.add_argument("--allow-ephemeral-test", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        print(json.dumps(materialize(parse_args(sys.argv[1:])), ensure_ascii=False, indent=2))
    except Exception as exc:  # preserve a bounded diagnostic without vectors or source data
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None
