#!/usr/bin/env python3
"""Exercise every enabled real adapter through the loopback HTTP API."""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path("/gemini/code/sgx-classification")
MODEL_ROOT = ROOT / "shared/models/candidates"
SOURCE_ROOT = (
    ROOT
    / "staging/packages/sgx-feature-service-source-20261003-r3"
    / "services/classification-feature-service/src"
)
IMAGE_FIXTURES = (
    ROOT
    / "shared/downloads/test-fixtures/synthetic-v2-component-smoke-20261003-r1"
)
ASR_FIXTURES = (
    ROOT
    / "shared/downloads/test-fixtures/synthetic-v2-asr-smoke-20261003-r1"
)
RESULT_PATH = (
    ROOT
    / "shared/manifests/component-smoke-feature-service-http-20261003-r2.result.json"
)
SERVER_LOG = (
    ROOT
    / "shared/manifests/component-smoke-feature-service-http-20261003-r2.server.log"
)
JOB_ROOT = Path("/tmp/sgx-classification/jobs")
JOB_DIR = JOB_ROOT / "feature-service-http-smoke-20261003-r2"
BASE_URL = "http://127.0.0.1:18765"


def sha256(path: Path) -> str:
    output = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            output.update(chunk)
    return output.hexdigest()


def source_request(path: Path) -> dict[str, object]:
    return {
        "sourcePath": str(path),
        "sourceSha256": sha256(path),
        "sourceByteLength": path.stat().st_size,
    }


def request_json(
    path: str,
    *,
    method: str = "GET",
    body: dict[str, object] | None = None,
    timeout: int = 180,
) -> tuple[int, dict]:
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        BASE_URL + path, data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def vector_summary(payload: dict) -> dict[str, object]:
    values = payload.get("vector")
    if not isinstance(values, list):
        raise ValueError("VECTOR_MISSING")
    return {
        "status": 200,
        "modelId": payload.get("modelId"),
        "modelRevision": payload.get("modelRevision"),
        "dimensions": payload.get("dimensions"),
        "normalized": payload.get("normalized"),
        "finite": all(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            for value in values
        ),
        "l2Norm": round(math.sqrt(sum(float(value) ** 2 for value in values)), 6),
    }


def write_result(result: dict) -> None:
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = RESULT_PATH.with_suffix(RESULT_PATH.suffix + ".tmp")
    temporary.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(RESULT_PATH)


def build_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "PYTHONPATH": str(SOURCE_ROOT),
            "SGX_ADAPTER_PROFILE": "real",
            "SGX_DEPLOY_ROOT": str(ROOT),
            "SGX_MODEL_ROOT": str(MODEL_ROOT),
            "SGX_JOB_TMP_ROOT": str(JOB_ROOT),
            "SGX_FEATURE_HOST": "127.0.0.1",
            "SGX_FEATURE_PORT": "18765",
            "SGX_MODEL_TRANSPORT_MODE": "offline_only",
            "SGX_ALLOW_MODEL_DOWNLOADS": "false",
            "SGX_RELEASE_ID": "sgx-internal-candidate-20261003-r2",
            "SGX_GIT_COMMIT": "uncommitted-source-r3",
            "SGX_RELEASE_MANIFEST_DIGEST": "699e1b49c6195d83f475889d4767670b4a9a91ef5d786ff09b664e14c255a575",
            "SGX_PYTHON_LOCK_DIGEST": "9099dff907e2ac93c25be57eb1f3087d0d6c7946853b2379f9edc6a2062aef56",
            "SGX_OCR_MODEL_ID": "rapidocr/PP-OCRv5-ch-mobile",
            "SGX_OCR_RUNTIME_VERSION": "3.9.2",
            "SGX_OCR_MODEL_REVISION": "rapidocr-3.9.2-ppocrv5-mobile",
            "SGX_OCR_DET_MODEL_PATH": str(
                MODEL_ROOT
                / "rapidocr/3.9.2/ppocrv5-mobile/ch_PP-OCRv5_det_mobile.onnx"
            ),
            "SGX_OCR_REC_MODEL_PATH": str(
                MODEL_ROOT
                / "rapidocr/3.9.2/ppocrv5-mobile/ch_PP-OCRv5_rec_mobile.onnx"
            ),
            "SGX_OCR_CLS_MODEL_PATH": str(
                MODEL_ROOT
                / "rapidocr/3.9.2/ppocrv5-mobile/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx"
            ),
            "SGX_OCR_DEVICE": "cpu",
            "SGX_EMBEDDING_BACKEND": "modelscope_chinese_clip",
            "SGX_IMAGE_EMBEDDING_MODEL_ID": "damo/multi-modal_clip-vit-base-patch16_zh",
            "SGX_TEXT_EMBEDDING_MODEL_ID": "damo/multi-modal_clip-vit-base-patch16_zh",
            "SGX_EMBEDDING_REVISION": "e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b",
            "SGX_IMAGE_EMBEDDING_REVISION": "e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b",
            "SGX_TEXT_EMBEDDING_REVISION": "e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b",
            "SGX_EMBEDDING_DIM": "512",
            "SGX_IMAGE_EMBEDDING_DIM": "512",
            "SGX_TEXT_EMBEDDING_DIM": "512",
            "SGX_EMBEDDING_MODEL_LICENSE": "Apache-2.0",
            "SGX_EMBEDDING_MODEL_PATH": str(
                MODEL_ROOT
                / "modelscope/damo--multi-modal_clip-vit-base-patch16_zh"
                / "e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b"
            ),
            "SGX_EMBEDDING_DEVICE": "cuda:0",
            "SGX_EMBEDDING_DTYPE": "float16",
            "SGX_EMBEDDING_BATCH_SIZE": "1",
            "SGX_FACE_MATCHING_ENABLED": "true",
            "SGX_FACE_DETECTOR_MODEL_REVISION": "47534e27c9851bb1128ccc0102f1145e27f23f98",
            "SGX_FACE_EMBEDDING_MODEL_REVISION": "47534e27c9851bb1128ccc0102f1145e27f23f98",
            "SGX_FACE_DETECTOR_MODEL_PATH": str(
                MODEL_ROOT
                / "opencv-zoo/47534e27c9851bb1128ccc0102f1145e27f23f98"
                / "face_detection_yunet/face_detection_yunet_2023mar.onnx"
            ),
            "SGX_FACE_EMBEDDING_MODEL_PATH": str(
                MODEL_ROOT
                / "opencv-zoo/47534e27c9851bb1128ccc0102f1145e27f23f98"
                / "face_recognition_sface/face_recognition_sface_2021dec.onnx"
            ),
            "SGX_FACE_DETECTOR_MODEL_LICENSE": "MIT",
            "SGX_FACE_EMBEDDING_MODEL_LICENSE": "Apache-2.0",
            "SGX_FACE_EMBEDDING_DIM": "128",
            "SGX_ASR_ENABLED": "true",
            "SGX_ASR_MODEL_ID": "iic/SenseVoiceSmall",
            "SGX_ASR_MODEL_VERSION": "SenseVoiceSmall",
            "SGX_ASR_MODEL_REVISION": "7bf452403abd7353a300cd760f7adae7701c92c1",
            "SGX_ASR_MODEL_PATH": str(
                MODEL_ROOT
                / "modelscope/iic--SenseVoiceSmall"
                / "7bf452403abd7353a300cd760f7adae7701c92c1"
            ),
            "SGX_ASR_RUNTIME_ID": "funasr",
            "SGX_ASR_RUNTIME_VERSION": "1.4.16",
            "SGX_ASR_DEVICE": "cuda:0",
            "SGX_ASR_CHUNK_SECONDS": "30",
            "CUDA_VISIBLE_DEVICES": "0",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "MODELSCOPE_OFFLINE": "1",
            "HF_HOME": str(ROOT / "shared/cache/huggingface"),
            "HF_HUB_CACHE": str(ROOT / "shared/cache/huggingface/hub"),
            "TRANSFORMERS_CACHE": str(ROOT / "shared/cache/huggingface/transformers"),
            "MODELSCOPE_CACHE": str(ROOT / "shared/cache/modelscope"),
            "TORCH_HOME": str(ROOT / "shared/cache/torch"),
            "XDG_CACHE_HOME": str(ROOT / "shared/cache/xdg"),
        }
    )
    return environment


def main() -> int:
    stage = "preflight"
    started = time.time()
    server = None
    log_handle = None
    result: dict = {
        "schemaVersion": "sgx-feature-service-http-smoke.1",
        "status": "failed",
        "claimBoundary": (
            "This loopback smoke validates that the four frozen local feature "
            "capabilities can coexist behind the reviewed HTTP contract on one "
            "target GPU. Synthetic fixtures do not establish real-user accuracy, "
            "person identity reliability, production SLA or product readiness."
        ),
        "persistentRoot": str(ROOT),
        "jobScratch": str(JOB_DIR),
        "serverLog": str(SERVER_LOG),
        "checks": {},
    }
    try:
        for required in (
            SOURCE_ROOT,
            MODEL_ROOT,
            IMAGE_FIXTURES,
            ASR_FIXTURES,
        ):
            required.resolve(strict=True).relative_to(ROOT.resolve(strict=True))
        JOB_ROOT.mkdir(parents=True, exist_ok=True)
        if JOB_DIR.exists():
            raise RuntimeError("JOB_DIR_ALREADY_EXISTS")
        JOB_DIR.mkdir(mode=0o700)
        inputs = {
            "image": IMAGE_FIXTURES / "SGX-V2-E012.jpg",
            "faces": IMAGE_FIXTURES / "SGX-SYN-E010.jpg",
            "text": ASR_FIXTURES / "SGX-SYN-E002.final-asr.txt",
            "audio": ASR_FIXTURES / "SGX-SYN-E002.wav",
        }
        job_inputs = {}
        for name, source in inputs.items():
            destination = JOB_DIR / source.name
            shutil.copy2(source, destination)
            if sha256(source) != sha256(destination):
                raise RuntimeError(f"JOB_COPY_HASH_MISMATCH:{name}")
            job_inputs[name] = destination

        stage = "server_start"
        log_handle = SERVER_LOG.open("wb")
        server = subprocess.Popen(
            [sys.executable, "-m", "sgx_classification_feature_service"],
            env=build_environment(),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
        )
        for _ in range(120):
            if server.poll() is not None:
                raise RuntimeError(f"SERVER_EXITED:{server.returncode}")
            try:
                status, payload = request_json("/healthz", timeout=2)
                if status == 200:
                    result["checks"]["health"] = payload
                    break
            except (OSError, ValueError):
                pass
            time.sleep(1)
        else:
            raise TimeoutError("SERVER_HEALTH_TIMEOUT")

        stage = "initial_ready"
        status, payload = request_json("/readyz")
        if status != 503 or payload.get("status") != "not_ready":
            raise RuntimeError("INITIAL_READY_CONTRACT_MISMATCH")
        result["checks"]["initialReady"] = {"httpStatus": status, **payload}

        stage = "version"
        status, payload = request_json("/version")
        if status != 200:
            raise RuntimeError("VERSION_FAILED")
        result["checks"]["version"] = payload

        stage = "ocr"
        status, payload = request_json(
            "/internal/v1/features/ocr",
            method="POST",
            body=source_request(job_inputs["image"]),
        )
        if status != 200 or not payload.get("regions"):
            raise RuntimeError(f"OCR_FAILED:{status}:{payload}")
        result["checks"]["ocr"] = {
            "httpStatus": status,
            "modelId": payload.get("modelId"),
            "modelRevision": payload.get("modelRevision"),
            "regionCount": len(payload["regions"]),
            "texts": [region.get("text") for region in payload["regions"]],
        }

        stage = "image_embedding"
        status, payload = request_json(
            "/internal/v1/features/image-embedding",
            method="POST",
            body=source_request(job_inputs["image"]),
        )
        if status != 200:
            raise RuntimeError(f"IMAGE_EMBEDDING_FAILED:{status}:{payload}")
        result["checks"]["imageEmbedding"] = vector_summary(payload)

        stage = "text_embedding"
        status, payload = request_json(
            "/internal/v1/features/text-embedding",
            method="POST",
            body=source_request(job_inputs["text"]),
        )
        if status != 200:
            raise RuntimeError(f"TEXT_EMBEDDING_FAILED:{status}:{payload}")
        result["checks"]["textEmbedding"] = vector_summary(payload)

        stage = "face_embeddings"
        status, payload = request_json(
            "/internal/v1/features/face-embeddings",
            method="POST",
            body=source_request(job_inputs["faces"]),
        )
        faces = payload.get("faces") if isinstance(payload, dict) else None
        if status != 200 or not isinstance(faces, list) or not faces:
            raise RuntimeError(f"FACE_EMBEDDING_FAILED:{status}:{payload}")
        result["checks"]["faceEmbeddings"] = {
            "httpStatus": status,
            "detectorModelId": payload.get("detectorModelId"),
            "detectorModelRevision": payload.get("detectorModelRevision"),
            "embeddingModelId": payload.get("embeddingModelId"),
            "embeddingModelRevision": payload.get("embeddingModelRevision"),
            "dimensions": payload.get("dimensions"),
            "normalized": payload.get("normalized"),
            "faceCount": len(faces),
            "allOpaqueIds": all(
                isinstance(face.get("faceId"), str)
                and face["faceId"].startswith("face_")
                for face in faces
            ),
            "allVectorDimensionsValid": all(
                len(face.get("vector", [])) == payload.get("dimensions")
                for face in faces
            ),
        }

        stage = "asr"
        status, payload = request_json(
            "/internal/v1/features/asr",
            method="POST",
            body=source_request(job_inputs["audio"]),
        )
        if status != 200 or not str(payload.get("text", "")).strip():
            raise RuntimeError(f"ASR_FAILED:{status}:{payload}")
        result["checks"]["asr"] = {
            "httpStatus": status,
            "modelId": payload.get("modelId"),
            "modelRevision": payload.get("modelRevision"),
            "runtimeId": payload.get("runtimeId"),
            "runtimeVersion": payload.get("runtimeVersion"),
            "text": payload.get("text"),
            "language": payload.get("language"),
            "durationMs": payload.get("durationMs"),
        }

        stage = "final_ready"
        status, payload = request_json("/readyz")
        if status != 200 or payload.get("status") != "ready":
            raise RuntimeError(f"FINAL_READY_FAILED:{status}:{payload}")
        result["checks"]["finalReady"] = {"httpStatus": status, **payload}
        result["status"] = "passed"
        result["totalLatencyMs"] = round((time.time() - started) * 1000, 3)
        write_result(result)
        return 0
    except Exception as exc:
        result["failure"] = {
            "stage": stage,
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(),
        }
        result["totalLatencyMs"] = round((time.time() - started) * 1000, 3)
        write_result(result)
        return 1
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=20)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=10)
        if log_handle is not None:
            log_handle.close()
        if JOB_DIR.exists():
            shutil.rmtree(JOB_DIR)


if __name__ == "__main__":
    raise SystemExit(main())
