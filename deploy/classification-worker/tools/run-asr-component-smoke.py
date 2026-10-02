#!/usr/bin/env python3
"""Run the frozen SenseVoice component smoke test from persistent artifacts.

This tool is deliberately target-environment specific. It reads only fixed
PCM WAV fixtures and a local model snapshot, performs no network access, and
writes a structured result beneath the persistent SGX manifest directory.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import traceback
import wave
from difflib import SequenceMatcher
from pathlib import Path


PERSISTENT_ROOT = Path("/gemini/code/sgx-classification")
SOURCE_ROOT = (
    PERSISTENT_ROOT
    / "staging/packages/sgx-feature-service-source-20261003-r3"
    / "services/classification-feature-service/src"
)
MODEL_PATH = (
    PERSISTENT_ROOT
    / "staging/models/modelscope/iic--SenseVoiceSmall"
    / "7bf452403abd7353a300cd760f7adae7701c92c1"
)
FIXTURE_ROOT = (
    PERSISTENT_ROOT
    / "shared/downloads/test-fixtures/synthetic-v2-asr-smoke-20261003-r1"
)
RESULT_PATH = (
    PERSISTENT_ROOT
    / "shared/manifests/component-smoke-asr-20261003-r2.result.json"
)
CASES = ("SGX-SYN-E002", "SGX-SYN-E010", "SGX-SYN-H002")
CLAIM_BOUNDARY = (
    "Three synthetic TTS clips validate persistent offline model loading, PCM "
    "decoding, bounded ASR inference, non-empty Chinese output and deterministic "
    "response structure. Similarity is a diagnostic, not real elderly-speech "
    "accuracy."
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_text(value: str) -> str:
    return "".join(character for character in value if not character.isspace())


def read_pcm(path: Path):
    from sgx_classification_feature_service.adapters import AudioPcm

    with wave.open(str(path), "rb") as audio_file:
        channels = audio_file.getnchannels()
        sample_width = audio_file.getsampwidth()
        sample_rate = audio_file.getframerate()
        frame_count = audio_file.getnframes()
        compression = audio_file.getcomptype()
        pcm = audio_file.readframes(frame_count)
    if sample_width != 2 or compression != "NONE":
        raise ValueError("FIXTURE_NOT_PCM_S16LE")
    return AudioPcm(
        pcm_s16le=pcm,
        sample_rate_hz=sample_rate,
        channels=channels,
        frame_count=frame_count,
        duration_ms=round(frame_count * 1000 / sample_rate),
    )


def write_result(result: dict) -> None:
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = RESULT_PATH.with_suffix(RESULT_PATH.suffix + ".tmp")
    temporary.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(RESULT_PATH)


def main() -> int:
    started_at = time.time()
    stage = "preflight"
    result: dict = {
        "schemaVersion": "sgx-component-smoke.asr.1",
        "status": "failed",
        "claimBoundary": CLAIM_BOUNDARY,
        "persistentRoot": str(PERSISTENT_ROOT),
        "sourceRoot": str(SOURCE_ROOT),
        "model": {
            "modelId": "iic/SenseVoiceSmall",
            "revision": "7bf452403abd7353a300cd760f7adae7701c92c1",
            "path": str(MODEL_PATH),
            "runtime": "funasr",
            "runtimeVersion": "1.4.16",
            "trustRemoteCode": False,
            "device": "cuda:0",
        },
        "fixtures": [],
    }
    try:
        for required in (SOURCE_ROOT, MODEL_PATH, FIXTURE_ROOT):
            resolved = required.resolve(strict=True)
            resolved.relative_to(PERSISTENT_ROOT.resolve(strict=True))
        sys.path.insert(0, str(SOURCE_ROOT))

        stage = "runtime_import"
        import funasr
        import torch

        from sgx_classification_feature_service.sensevoice_runtime import (
            FunAsrSenseVoiceRuntime,
        )

        result["runtime"] = {
            "python": sys.version.split()[0],
            "funasr": getattr(funasr, "__version__", "unknown"),
            "torch": torch.__version__,
            "cudaAvailable": bool(torch.cuda.is_available()),
            "cudaDeviceCount": int(torch.cuda.device_count()),
            "cudaDeviceName": (
                torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
            ),
            "offlineEnvironment": {
                name: os.getenv(name)
                for name in (
                    "HF_HUB_OFFLINE",
                    "TRANSFORMERS_OFFLINE",
                    "MODELSCOPE_OFFLINE",
                )
            },
        }

        stage = "model_load"
        load_started = time.perf_counter()
        runtime = FunAsrSenseVoiceRuntime(
            MODEL_PATH,
            runtime_version="1.4.16",
            device="cuda:0",
            chunk_seconds=30,
        )
        result["modelLoadLatencyMs"] = round(
            (time.perf_counter() - load_started) * 1000, 3
        )

        for case_id in CASES:
            stage = f"fixture:{case_id}"
            wav_path = FIXTURE_ROOT / f"{case_id}.wav"
            truth_path = FIXTURE_ROOT / f"{case_id}.final-asr.txt"
            expected = truth_path.read_text(encoding="utf-8").strip()
            audio = read_pcm(wav_path)
            inference_started = time.perf_counter()
            transcript = runtime.transcribe(audio)
            latency_ms = round(
                (time.perf_counter() - inference_started) * 1000, 3
            )
            normalized_expected = normalize_text(expected)
            normalized_actual = normalize_text(transcript.text)
            fixture_result = {
                "caseId": case_id,
                "wavPath": str(wav_path),
                "wavSha256": sha256(wav_path),
                "truthPath": str(truth_path),
                "truthSha256": sha256(truth_path),
                "audio": {
                    "sampleRateHz": audio.sample_rate_hz,
                    "channels": audio.channels,
                    "frameCount": audio.frame_count,
                    "durationMs": audio.duration_ms,
                },
                "expectedText": expected,
                "actualText": transcript.text,
                "detectedLanguage": transcript.language,
                "segments": transcript.segments,
                "nonEmpty": bool(normalized_actual),
                "normalizedExactMatch": normalized_actual == normalized_expected,
                "characterSequenceSimilarity": round(
                    SequenceMatcher(
                        None, normalized_expected, normalized_actual
                    ).ratio(),
                    6,
                ),
                "latencyMs": latency_ms,
            }
            if not fixture_result["nonEmpty"]:
                raise ValueError("EMPTY_ASR_TRANSCRIPT")
            result["fixtures"].append(fixture_result)

        result["status"] = "passed"
        result["completedAtUnixSeconds"] = round(time.time(), 3)
        result["totalLatencyMs"] = round((time.time() - started_at) * 1000, 3)
        write_result(result)
        return 0
    except Exception as exc:
        result["failure"] = {
            "stage": stage,
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(),
        }
        result["completedAtUnixSeconds"] = round(time.time(), 3)
        result["totalLatencyMs"] = round((time.time() - started_at) * 1000, 3)
        write_result(result)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
