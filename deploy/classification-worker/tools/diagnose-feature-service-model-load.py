#!/usr/bin/env python3
"""Capture an internal adapter load traceback without exposing it over HTTP."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
import traceback
from pathlib import Path


DEFAULT_CONFIG = Path(
    "/gemini/code/sgx-classification/shared/tools/validation/"
    "run-feature-service-http-smoke-20261003-r1.py"
)
DEFAULT_OUTPUT = Path(
    "/gemini/code/sgx-classification/shared/manifests/"
    "feature-service-model-load-diagnostic-20261003-r1.json"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "capability",
        choices=("ocr", "image_embedding", "text_embedding", "face_embedding", "asr"),
    )
    parser.add_argument("--config-script", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    result = {
        "schemaVersion": "sgx-feature-service-model-load-diagnostic.1",
        "status": "failed",
        "capability": args.capability,
        "configScript": str(args.config_script),
        "claimBoundary": (
            "Internal target-environment diagnostic only. Raw exception details "
            "must not be returned by the product HTTP API."
        ),
    }
    started = time.time()
    try:
        spec = importlib.util.spec_from_file_location("sgx_smoke_config", args.config_script)
        if spec is None or spec.loader is None:
            raise RuntimeError("CONFIG_SCRIPT_IMPORT_FAILED")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        environment = module.build_environment()
        os.environ.update(environment)
        source_root = Path(environment["PYTHONPATH"])
        sys.path.insert(0, str(source_root))

        from sgx_classification_feature_service.config import Settings
        from sgx_classification_feature_service.real_adapters import (
            factories_for_settings,
        )

        settings = Settings.from_env()
        factories = factories_for_settings(settings)
        factory = getattr(factories, args.capability)
        if factory is None:
            raise RuntimeError("CAPABILITY_FACTORY_DISABLED")
        adapter = factory()
        load_started = time.perf_counter()
        adapter.load()
        result["loadLatencyMs"] = round(
            (time.perf_counter() - load_started) * 1000, 3
        )
        result["loaded"] = bool(adapter.loaded)
        result["adapterType"] = type(adapter).__name__
        result["status"] = "passed"
    except Exception as exc:
        result["failure"] = {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(),
        }
    result["totalLatencyMs"] = round((time.time() - started) * 1000, 3)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(args.out)
    print(json.dumps({"output": str(args.out), "status": result["status"]}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
