#!/usr/bin/env python3
"""Promote verified staging trees into the persistent candidate registry.

The operation is additive and idempotent. Existing destinations are accepted
only when every regular file matches the staged source by relative path, size
and SHA-256. No staging or earlier evidence is deleted.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import time
from pathlib import Path


ROOT = Path("/gemini/code/sgx-classification")
STAGING = ROOT / "staging/models"
CANDIDATES = ROOT / "shared/models/candidates"
MANIFEST = ROOT / "shared/manifests/candidate-model-registry-20261003-r1.json"

COMPONENTS = (
    {
        "capability": "ocr",
        "modelId": "rapidocr/PP-OCRv5-ch-mobile",
        "revision": "rapidocr-3.9.2-ppocrv5-mobile",
        "license": "Apache-2.0 runtime; model artifact provenance receipt retained",
        "source": STAGING / "rapidocr/3.9.2/ppocrv5-mobile",
        "destination": CANDIDATES / "rapidocr/3.9.2/ppocrv5-mobile",
        "evidence": ROOT
        / "shared/manifests/component-smoke-ocr-face-20261003-r1.result.json",
    },
    {
        "capability": "anonymous_face_candidate",
        "modelId": "opencv-zoo/YuNet+SFace",
        "revision": "47534e27c9851bb1128ccc0102f1145e27f23f98",
        "license": "MIT YuNet; Apache-2.0 SFace; internal evaluation candidate",
        "source": STAGING
        / "opencv-zoo/47534e27c9851bb1128ccc0102f1145e27f23f98",
        "destination": CANDIDATES
        / "opencv-zoo/47534e27c9851bb1128ccc0102f1145e27f23f98",
        "evidence": ROOT
        / "shared/manifests/component-smoke-ocr-face-20261003-r1.result.json",
    },
    {
        "capability": "image_text_embedding",
        "modelId": "damo/multi-modal_clip-vit-base-patch16_zh",
        "revision": "e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b",
        "license": "Apache-2.0",
        "source": STAGING
        / "modelscope/damo--multi-modal_clip-vit-base-patch16_zh"
        / "e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b",
        "destination": CANDIDATES
        / "modelscope/damo--multi-modal_clip-vit-base-patch16_zh"
        / "e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b",
        "evidence": ROOT
        / "shared/manifests/component-smoke-embedding-20261003-r3.result.json",
    },
    {
        "capability": "asr",
        "modelId": "iic/SenseVoiceSmall",
        "revision": "7bf452403abd7353a300cd760f7adae7701c92c1",
        "license": "Apache-2.0",
        "source": STAGING
        / "modelscope/iic--SenseVoiceSmall"
        / "7bf452403abd7353a300cd760f7adae7701c92c1",
        "destination": CANDIDATES
        / "modelscope/iic--SenseVoiceSmall"
        / "7bf452403abd7353a300cd760f7adae7701c92c1",
        "evidence": ROOT
        / "shared/manifests/component-smoke-asr-20261003-r2.result.json",
    },
)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inventory(root: Path) -> list[dict[str, object]]:
    files = []
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": digest(path),
            }
        )
    return files


def main() -> None:
    resolved_root = ROOT.resolve(strict=True)
    CANDIDATES.mkdir(parents=True, exist_ok=True)
    promoted = []
    for component in COMPONENTS:
        source = component["source"]
        destination = component["destination"]
        if not isinstance(source, Path) or not isinstance(destination, Path):
            raise TypeError("INVALID_COMPONENT_PATH")
        source.resolve(strict=True).relative_to(resolved_root)
        destination.absolute().relative_to(resolved_root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.parent.resolve(strict=True).relative_to(resolved_root)
        source_files = inventory(source)
        if not source_files:
            raise RuntimeError(f"EMPTY_SOURCE:{source}")
        if destination.exists():
            destination_files = inventory(destination)
            if destination_files != source_files:
                raise RuntimeError(f"EXISTING_DESTINATION_MISMATCH:{destination}")
            operation = "verified_existing"
        else:
            shutil.copytree(source, destination, symlinks=False)
            destination_files = inventory(destination)
            if destination_files != source_files:
                raise RuntimeError(f"PROMOTION_COPY_MISMATCH:{destination}")
            operation = "copied_and_verified"
        evidence = component["evidence"]
        if not isinstance(evidence, Path):
            raise TypeError("INVALID_EVIDENCE_PATH")
        evidence.resolve(strict=True).relative_to(resolved_root)
        promoted.append(
            {
                key: value
                for key, value in component.items()
                if key not in {"source", "destination", "evidence"}
            }
            | {
                "source": str(source),
                "destination": str(destination),
                "operation": operation,
                "files": destination_files,
                "totalBytes": sum(int(item["bytes"]) for item in destination_files),
                "verificationEvidence": {
                    "path": str(evidence),
                    "sha256": digest(evidence),
                },
            }
        )

    payload = {
        "schemaVersion": "sgx-candidate-model-registry.1",
        "status": "internal_release_candidate",
        "createdAtUnixSeconds": round(time.time(), 3),
        "persistentRoot": str(ROOT),
        "claimBoundary": (
            "Candidates passed fixed component execution smokes only. This registry "
            "does not establish real-user accuracy, identity reliability, production "
            "SLA or unrestricted commercial suitability."
        ),
        "components": promoted,
    }
    temporary = MANIFEST.with_suffix(MANIFEST.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(MANIFEST)
    print(json.dumps({"manifest": str(MANIFEST), "sha256": digest(MANIFEST)}))


if __name__ == "__main__":
    main()
