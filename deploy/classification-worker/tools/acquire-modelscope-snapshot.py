#!/usr/bin/env python3
"""Acquire one immutable public ModelScope snapshot into persistent staging.

This is an operator tool, not runtime code. It performs one network attempt per
file, keeps failed partial files for audit, verifies the server-declared size
and SHA-256, and writes a receipt only after the complete snapshot is present.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import quote_plus


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _below(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _checked_path(raw: str, persistent_root: Path, *, must_exist: bool) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError(f"path must be absolute: {raw}")
    resolved = path.resolve(strict=must_exist)
    if not _below(resolved, persistent_root):
        raise ValueError(f"path must stay below persistent root: {raw}")
    return resolved


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _load_files(manifest: Path, *, forbid_python: bool) -> list[dict[str, object]]:
    document = json.loads(manifest.read_text(encoding="utf-8"))
    payload = document.get("Data", document.get("data", document))
    if isinstance(payload, dict):
        files = payload.get("Files", payload.get("files"))
    else:
        files = payload
    if not isinstance(files, list):
        raise ValueError("manifest has no ModelScope Files list")

    checked: list[dict[str, object]] = []
    for item in files:
        if not isinstance(item, dict) or item.get("Type") == "tree":
            continue
        raw_path = item.get("Path")
        expected_hash = item.get("Sha256")
        expected_size = item.get("Size")
        if not isinstance(raw_path, str):
            raise ValueError("manifest file Path must be a string")
        relative = PurePosixPath(raw_path)
        if relative.is_absolute() or not relative.parts or ".." in relative.parts:
            raise ValueError(f"unsafe repository path: {raw_path}")
        if forbid_python and relative.suffix.lower() == ".py":
            raise ValueError(f"repository Python is forbidden: {raw_path}")
        if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
            raise ValueError(f"missing or invalid SHA-256 for {raw_path}")
        if not isinstance(expected_size, int) or expected_size < 0:
            raise ValueError(f"missing or invalid byte size for {raw_path}")
        checked.append(
            {
                "path": raw_path,
                "sha256": expected_hash,
                "bytes": expected_size,
            }
        )
    if not checked:
        raise ValueError("manifest contains no downloadable blobs")
    return sorted(checked, key=lambda value: str(value["path"]))


def _append_event(path: Path, event: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    path.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument(
        "--persistent-root", default="/gemini/code/sgx-classification"
    )
    parser.add_argument("--forbid-python", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    persistent_root = Path(args.persistent_root).expanduser().resolve(strict=True)
    manifest = _checked_path(args.manifest, persistent_root, must_exist=True)
    output = _checked_path(args.out, persistent_root, must_exist=False)
    receipt = _checked_path(args.receipt, persistent_root, must_exist=False)
    ledger = _checked_path(args.ledger, persistent_root, must_exist=False)
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", args.model_id):
        raise ValueError("model ID contains unsupported characters")
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise ValueError("revision must be a full 40-character commit")

    files = _load_files(manifest, forbid_python=args.forbid_python)
    if args.dry_run:
        print(
            json.dumps(
                {
                    "status": "dry_run",
                    "automaticRetries": 0,
                    "fileCount": len(files),
                    "totalBytes": sum(int(item["bytes"]) for item in files),
                    "output": str(output),
                },
                indent=2,
            )
        )
        return 0

    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output.is_symlink() or not _below(output.resolve(strict=True), persistent_root):
        raise ValueError("output path resolves outside persistent root")
    receipt.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    ledger.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    manifest_hash = _sha256(manifest)
    verified: list[dict[str, object]] = []
    for item in files:
        relative = PurePosixPath(str(item["path"]))
        target = output.joinpath(*relative.parts)
        if target.exists() and (
            target.is_symlink()
            or not _below(target.resolve(strict=True), output.resolve(strict=True))
        ):
            raise ValueError(f"target escapes output root: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        partial = target.with_name(target.name + ".partial")
        expected_hash = str(item["sha256"])
        expected_size = int(item["bytes"])

        if target.is_file():
            actual_hash = _sha256(target)
            actual_size = target.stat().st_size
            if actual_hash != expected_hash or actual_size != expected_size:
                raise ValueError(f"existing target failed verification: {relative}")
            _append_event(
                ledger,
                {"event": "existing_verified", "path": str(relative)},
            )
        else:
            if partial.exists():
                raise ValueError(
                    f"partial file already exists; explicit operator recovery required: {partial}"
                )
            url = (
                "https://www.modelscope.cn/api/v1/models/"
                f"{args.model_id}/repo?Revision={args.revision}"
                f"&FilePath={quote_plus(str(relative))}"
            )
            _append_event(
                ledger,
                {
                    "event": "download_started",
                    "path": str(relative),
                    "source": url,
                    "automaticRetries": 0,
                },
            )
            completed = subprocess.run(
                [
                    "curl",
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--retry",
                    "0",
                    "--connect-timeout",
                    "20",
                    "--max-time",
                    "7200",
                    url,
                    "--output",
                    str(partial),
                ],
                check=False,
            )
            if completed.returncode != 0:
                _append_event(
                    ledger,
                    {
                        "event": "download_failed",
                        "path": str(relative),
                        "curlExitCode": completed.returncode,
                    },
                )
                return 2
            actual_size = partial.stat().st_size
            actual_hash = _sha256(partial)
            if actual_size != expected_size or actual_hash != expected_hash:
                _append_event(
                    ledger,
                    {
                        "event": "verification_failed",
                        "path": str(relative),
                        "expectedBytes": expected_size,
                        "actualBytes": actual_size,
                        "expectedSha256": expected_hash,
                        "actualSha256": actual_hash,
                    },
                )
                return 3
            partial.chmod(0o600)
            os.replace(partial, target)
            _append_event(
                ledger,
                {"event": "download_verified", "path": str(relative)},
            )
        verified.append(item)

    receipt_document = {
        "schemaVersion": "sgx-modelscope-acquisition-receipt.1",
        "status": "downloaded_persistent_verified",
        "modelId": args.model_id,
        "revision": args.revision,
        "automaticRetries": 0,
        "sourceManifest": str(manifest),
        "sourceManifestSha256": manifest_hash,
        "output": str(output),
        "fileCount": len(verified),
        "totalBytes": sum(int(item["bytes"]) for item in verified),
        "files": verified,
    }
    temporary_receipt = receipt.with_name(receipt.name + ".partial")
    temporary_receipt.write_text(
        json.dumps(receipt_document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_receipt.chmod(0o600)
    os.replace(temporary_receipt, receipt)
    print(json.dumps(receipt_document, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ACQUISITION_ERROR: {error}", file=sys.stderr)
        raise SystemExit(2) from error
