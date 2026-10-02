from __future__ import annotations

import hashlib
import os
import wave
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from sgx_classification_feature_service.adapters import (
    AdapterFactories,
    AsrSegment,
    AsrTranscript,
    AudioPcm,
    BoundingBox,
    EmbeddingVector,
    FaceEmbedding,
    OcrRegion,
)
from sgx_classification_feature_service.app import create_app
from sgx_classification_feature_service.config import Settings


class FakeOcr:
    model_id = "fake/ocr"
    model_version = "1.0.0"
    model_revision = "ocr-rev-1"

    def __init__(self) -> None:
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def extract(self, image: Image.Image, source_sha256: str) -> list[OcrRegion]:
        assert image.mode == "RGB"
        assert len(source_sha256) == 64
        return [
            OcrRegion(
                text="家庭合影",
                bounds=BoundingBox(x=0, y=0, width=image.width, height=image.height),
                model_score=0.91,
            )
        ]


class FakeImageEmbedding:
    model_id = "fake/cross-modal-embedding"
    model_revision = "cross-modal-rev-1"
    dimensions = 2
    normalized = True

    def __init__(self) -> None:
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def embed_image(
        self, image: Image.Image, source_sha256: str
    ) -> EmbeddingVector:
        assert image.mode == "RGB"
        assert len(source_sha256) == 64
        return EmbeddingVector(values=[0.6, 0.8])


class FakeTextEmbedding:
    model_id = "fake/cross-modal-embedding"
    model_revision = "cross-modal-rev-1"
    dimensions = 2
    normalized = True

    def __init__(self) -> None:
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def embed_text(self, text: str, source_sha256: str) -> EmbeddingVector:
        assert text == "这是一次家庭聚会。"
        assert len(source_sha256) == 64
        return EmbeddingVector(values=[0.8, 0.6])


class FakeFaceEmbedding:
    detector_model_id = "fake/yunet"
    detector_model_revision = "yunet-rev-1"
    model_id = "fake/sface"
    model_revision = "sface-rev-1"
    dimensions = 2
    normalized = True

    def __init__(self) -> None:
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def embed_faces(
        self, image: Image.Image, source_sha256: str
    ) -> list[FaceEmbedding]:
        return [
            FaceEmbedding(
                face_id="face_" + "a" * 32,
                bounds=BoundingBox(x=1, y=1, width=4, height=3),
                vector=EmbeddingVector(values=[0.6, 0.8]),
                detector_score=0.92,
            )
        ]


class FakeAsr:
    model_id = "fake/sensevoice-small"
    model_version = "1.0.0"
    model_revision = "asr-rev-1"
    runtime_id = "fake/funasr"
    runtime_version = "2.0.0"

    def __init__(self) -> None:
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def transcribe(
        self, audio: AudioPcm, source_sha256: str
    ) -> AsrTranscript:
        assert audio.sample_rate_hz == 16_000
        assert audio.channels == 1
        assert audio.duration_ms == 100
        assert len(source_sha256) == 64
        return AsrTranscript(
            text="今天我们一家人在公园散步。",
            language="zh",
            segments=[
                AsrSegment(
                    text="今天我们一家人在公园散步。",
                    start_ms=0,
                    end_ms=100,
                )
            ],
        )


def _settings(job_root: Path) -> Settings:
    return Settings(
        job_tmp_root=job_root,
        release_id="test-release",
        git_commit="a" * 40,
        release_manifest_digest="sha256:" + "b" * 64,
        dependency_lock_digest="sha256:" + "c" * 64,
        ocr_model_id=FakeOcr.model_id,
        ocr_model_version=FakeOcr.model_version,
        ocr_model_revision=FakeOcr.model_revision,
        image_embedding_model_id=FakeImageEmbedding.model_id,
        image_embedding_model_revision=FakeImageEmbedding.model_revision,
        image_embedding_dimensions=FakeImageEmbedding.dimensions,
        text_embedding_model_id=FakeTextEmbedding.model_id,
        text_embedding_model_revision=FakeTextEmbedding.model_revision,
        text_embedding_dimensions=FakeTextEmbedding.dimensions,
    )


def _client(job_root: Path) -> TestClient:
    factories = AdapterFactories(
        ocr=FakeOcr,
        image_embedding=FakeImageEmbedding,
        text_embedding=FakeTextEmbedding,
    )
    return TestClient(create_app(settings=_settings(job_root), adapter_factories=factories))


def _face_client(job_root: Path) -> TestClient:
    settings = replace(
        _settings(job_root),
        face_matching_enabled=True,
        face_detector_model_id=FakeFaceEmbedding.detector_model_id,
        face_detector_model_revision=FakeFaceEmbedding.detector_model_revision,
        face_embedding_model_id=FakeFaceEmbedding.model_id,
        face_embedding_model_revision=FakeFaceEmbedding.model_revision,
        face_embedding_dimensions=FakeFaceEmbedding.dimensions,
    )
    factories = AdapterFactories(
        ocr=FakeOcr,
        image_embedding=FakeImageEmbedding,
        text_embedding=FakeTextEmbedding,
        face_embedding=FakeFaceEmbedding,
    )
    return TestClient(create_app(settings=settings, adapter_factories=factories))


def _asr_client(job_root: Path, **overrides: object) -> TestClient:
    settings = replace(
        _settings(job_root),
        asr_enabled=True,
        asr_model_id=FakeAsr.model_id,
        asr_model_version=FakeAsr.model_version,
        asr_model_revision=FakeAsr.model_revision,
        asr_runtime_id=FakeAsr.runtime_id,
        asr_runtime_version=FakeAsr.runtime_version,
        **overrides,
    )
    factories = AdapterFactories(
        ocr=FakeOcr,
        image_embedding=FakeImageEmbedding,
        text_embedding=FakeTextEmbedding,
        asr=FakeAsr,
    )
    return TestClient(create_app(settings=settings, adapter_factories=factories))


def _write_image(path: Path) -> dict[str, object]:
    Image.new("RGB", (8, 6), color=(30, 60, 90)).save(path, format="PNG")
    data = path.read_bytes()
    return {
        "sourcePath": str(path),
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "sourceByteLength": len(data),
    }


def _write_text(path: Path) -> dict[str, object]:
    data = "这是一次家庭聚会。".encode("utf-8")
    path.write_bytes(data)
    return {
        "sourcePath": str(path),
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "sourceByteLength": len(data),
    }


def _write_wav(path: Path, *, duration_ms: int = 100) -> dict[str, object]:
    frame_count = 16_000 * duration_ms // 1000
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16_000)
        stream.writeframes(b"\x00\x00" * frame_count)
    data = path.read_bytes()
    return {
        "sourcePath": str(path),
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "sourceByteLength": len(data),
    }


def test_health_version_and_lazy_ready_transition(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    image_ref = _write_image(job_root / "photo.png")
    text_ref = _write_text(job_root / "caption.txt")
    client = _client(job_root)

    health = client.get("/healthz")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    version = client.get("/version")
    assert version.status_code == 200
    assert version.json()["releaseId"] == "test-release"
    assert "jobTmpRoot" not in version.json()

    before = client.get("/readyz")
    assert before.status_code == 503
    assert before.json()["components"]["ocr"]["status"] == "not_loaded"

    ocr = client.post("/internal/v1/features/ocr", json=image_ref)
    assert ocr.status_code == 200
    assert ocr.json()["sourceSha256"] == image_ref["sourceSha256"]
    assert ocr.json()["modelVersion"] == "1.0.0"
    assert ocr.json()["regions"][0]["text"] == "家庭合影"
    assert ocr.json()["regions"][0]["bounds"] == {
        "x": 0,
        "y": 0,
        "width": 8,
        "height": 6,
    }

    image_embedding = client.post(
        "/internal/v1/features/image-embedding", json=image_ref
    )
    assert image_embedding.status_code == 200
    assert image_embedding.json()["dimensions"] == 2
    assert image_embedding.json()["normalized"] is True
    assert image_embedding.json()["vector"] == [0.6, 0.8]

    text_embedding = client.post(
        "/internal/v1/features/text-embedding", json=text_ref
    )
    assert text_embedding.status_code == 200
    assert text_embedding.json()["modelRevision"] == "cross-modal-rev-1"

    after = client.get("/readyz")
    assert after.status_code == 200
    assert after.json()["status"] == "ready"


def test_rejects_path_outside_job_root(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    outside = tmp_path / "outside.png"
    payload = _write_image(outside)

    response = _client(job_root).post("/internal/v1/features/ocr", json=payload)

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "SOURCE_PATH_OUTSIDE_JOB_ROOT"


def test_rejects_symlink_escape(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    outside = tmp_path / "outside.png"
    payload = _write_image(outside)
    linked = job_root / "linked.png"
    try:
        os.symlink(outside, linked)
    except OSError:
        pytest.skip("symlink creation unavailable")
    payload["sourcePath"] = str(linked)

    response = _client(job_root).post("/internal/v1/features/ocr", json=payload)

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "SOURCE_PATH_OUTSIDE_JOB_ROOT"


def test_rejects_hash_mismatch(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_image(job_root / "photo.png")
    payload["sourceSha256"] = "0" * 64

    response = _client(job_root).post("/internal/v1/features/ocr", json=payload)

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "SOURCE_HASH_MISMATCH"


def test_rejects_declared_size_mismatch(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_image(job_root / "photo.png")
    payload["sourceByteLength"] = int(payload["sourceByteLength"]) + 1

    response = _client(job_root).post(
        "/internal/v1/features/image-embedding", json=payload
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "SOURCE_SIZE_MISMATCH"


def test_rejects_invalid_image_before_model_load(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    invalid = job_root / "not-an-image.bin"
    invalid.write_bytes(b"not an image")
    data = invalid.read_bytes()
    payload = {
        "sourcePath": str(invalid),
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "sourceByteLength": len(data),
    }
    client = _client(job_root)

    response = client.post("/internal/v1/features/ocr", json=payload)

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "IMAGE_DECODE_FAILED"
    assert client.get("/readyz").json()["components"]["ocr"]["status"] == "not_loaded"


def test_rejects_remote_url(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = {
        "sourcePath": "https://example.invalid/photo.png",
        "sourceSha256": "0" * 64,
        "sourceByteLength": 1,
    }

    response = _client(job_root).post("/internal/v1/features/ocr", json=payload)

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "REMOTE_SOURCE_FORBIDDEN"


def test_face_embedding_is_disabled_without_explicit_enablement(
    tmp_path: Path,
) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_image(job_root / "photo.png")

    response = _client(job_root).post(
        "/internal/v1/features/face-embeddings", json=payload
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "FACE_MATCHING_DISABLED"


def test_face_embedding_returns_detection_id_without_person_claim(
    tmp_path: Path,
) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_image(job_root / "photo.png")
    client = _face_client(job_root)

    response = client.post(
        "/internal/v1/features/face-embeddings", json=payload
    )

    assert response.status_code == 200
    body = response.json()
    assert body["detectorModelId"] == "fake/yunet"
    assert body["embeddingModelId"] == "fake/sface"
    assert body["faces"][0]["faceId"] == "face_" + "a" * 32
    assert "name" not in body["faces"][0]
    assert "relationship" not in body["faces"][0]
    assert body["faces"][0]["vector"] == [0.6, 0.8]


def test_asr_is_disabled_without_explicit_enablement(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_wav(job_root / "voice.wav")

    response = _client(job_root).post("/internal/v1/features/asr", json=payload)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ASR_DISABLED"


def test_asr_validates_pcm_wav_and_returns_frozen_provenance(
    tmp_path: Path,
) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_wav(job_root / "voice.wav")

    response = _asr_client(job_root).post(
        "/internal/v1/features/asr", json=payload
    )

    assert response.status_code == 200
    body = response.json()
    assert body["audioFormat"] == "wav-pcm-s16le"
    assert body["durationMs"] == 100
    assert body["modelId"] == FakeAsr.model_id
    assert body["modelRevision"] == FakeAsr.model_revision
    assert body["runtimeId"] == FakeAsr.runtime_id
    assert body["runtimeVersion"] == FakeAsr.runtime_version
    assert body["language"] == "zh"
    assert body["segments"][0]["endMs"] == 100


def test_asr_rejects_invalid_audio_before_model_load(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    invalid = job_root / "voice.wav"
    invalid.write_bytes(b"not a wav")
    data = invalid.read_bytes()
    payload = {
        "sourcePath": str(invalid),
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "sourceByteLength": len(data),
    }
    client = _asr_client(job_root)

    response = client.post("/internal/v1/features/asr", json=payload)

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "AUDIO_DECODE_FAILED"
    assert client.get("/readyz").json()["components"]["asr"]["status"] == (
        "not_loaded"
    )


def test_asr_rejects_audio_duration_limit(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_wav(job_root / "voice.wav", duration_ms=100)

    response = _asr_client(job_root, max_audio_duration_ms=50).post(
        "/internal/v1/features/asr", json=payload
    )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "AUDIO_DURATION_EXCEEDED"


def test_asr_rejects_audio_byte_limit_before_read(tmp_path: Path) -> None:
    job_root = tmp_path / "jobs"
    job_root.mkdir()
    payload = _write_wav(job_root / "voice.wav")

    response = _asr_client(job_root, max_audio_bytes=32).post(
        "/internal/v1/features/asr", json=payload
    )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "AUDIO_SOURCE_TOO_LARGE"
