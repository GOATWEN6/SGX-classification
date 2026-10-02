from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path

from . import __version__


DEFAULT_PERSISTENT_ROOT = Path("/gemini/code/sgx-classification")
DEFAULT_MODEL_ROOT = DEFAULT_PERSISTENT_ROOT / "shared/models"
DEFAULT_SIGLIP_REVISION = "0ad8c6e0ff16615356a08a1ad8c8bbc8930c434e"


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not 0 <= value <= 1:
        raise ValueError(f"{name} must be between 0 and 1")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _is_lexically_below(candidate: Path, root: Path) -> bool:
    candidate = Path(os.path.abspath(os.fspath(candidate)))
    root = Path(os.path.abspath(os.fspath(root)))
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return candidate != root


def _validate_model_path(name: str, candidate: Path, model_root: Path) -> None:
    if not candidate.is_absolute():
        raise ValueError(f"{name} must be an absolute path")
    if not _is_lexically_below(candidate, model_root):
        raise ValueError(f"{name} must stay below SGX_MODEL_ROOT")


def _validate_bind_host(host: str) -> None:
    if host == "localhost":
        return
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("SGX_FEATURE_HOST must be localhost or an IP address") from exc
    if address.is_unspecified or not (address.is_loopback or address.is_private):
        raise ValueError("SGX_FEATURE_HOST must not expose the service publicly")


@dataclass(frozen=True)
class Settings:
    job_tmp_root: Path = Path("/tmp/sgx-classification/jobs")
    bind_host: str = "127.0.0.1"
    bind_port: int = 8765
    max_source_bytes: int = 25 * 1024 * 1024
    max_text_bytes: int = 1024 * 1024
    max_image_pixels: int = 80_000_000
    max_audio_bytes: int = 50 * 1024 * 1024
    max_audio_duration_ms: int = 10 * 60 * 1000
    min_audio_sample_rate_hz: int = 8_000
    max_audio_sample_rate_hz: int = 48_000
    max_audio_channels: int = 2

    adapter_profile: str = "unconfigured"
    persistent_root: Path = DEFAULT_PERSISTENT_ROOT
    model_root: Path = DEFAULT_MODEL_ROOT
    model_transport_mode: str = "offline_only"
    allow_model_downloads: bool = False

    service_version: str = __version__
    release_id: str = "unreleased"
    git_commit: str = "unknown"
    release_manifest_digest: str = "unknown"
    dependency_lock_digest: str = "unknown"
    contract_version: str = "classification-feature-service.v1"

    ocr_model_id: str = "rapidocr/PP-OCRv5-ch-mobile"
    ocr_model_version: str = "3.9.2"
    ocr_model_revision: str = "unfrozen"
    ocr_detection_model_path: Path = (
        DEFAULT_MODEL_ROOT
        / "rapidocr/ppocrv5-mobile/ch_PP-OCRv5_det_mobile.onnx"
    )
    ocr_recognition_model_path: Path = (
        DEFAULT_MODEL_ROOT
        / "rapidocr/ppocrv5-mobile/ch_PP-OCRv5_rec_mobile.onnx"
    )
    ocr_classifier_model_path: Path = (
        DEFAULT_MODEL_ROOT
        / "rapidocr/ppocrv5-mobile/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx"
    )
    ocr_device: str = "cpu"
    embedding_backend: str = "siglip2"
    image_embedding_model_id: str = "google/siglip2-base-patch16-224"
    image_embedding_model_revision: str = DEFAULT_SIGLIP_REVISION
    image_embedding_dimensions: int = 768
    text_embedding_model_id: str = "google/siglip2-base-patch16-224"
    text_embedding_model_revision: str = DEFAULT_SIGLIP_REVISION
    text_embedding_dimensions: int = 768
    embedding_model_license: str = "Apache-2.0"
    embedding_model_path: Path = (
        DEFAULT_MODEL_ROOT
        / "siglip2/google--siglip2-base-patch16-224"
        / DEFAULT_SIGLIP_REVISION
    )
    embedding_device: str = "cuda:0"
    embedding_dtype: str = "float16"
    embedding_batch_size: int = 1

    face_matching_enabled: bool = False
    face_detector_model_id: str = "opencv-zoo/face_detection_yunet_2023mar"
    face_detector_model_revision: str = "unfrozen"
    face_detector_model_license: str = "MIT"
    face_detector_model_path: Path = (
        DEFAULT_MODEL_ROOT
        / "opencv-zoo/face_detection_yunet/face_detection_yunet_2023mar.onnx"
    )
    face_embedding_model_id: str = "opencv-zoo/face_recognition_sface_2021dec"
    face_embedding_model_revision: str = "unfrozen"
    face_embedding_model_license: str = "Apache-2.0"
    face_embedding_model_path: Path = (
        DEFAULT_MODEL_ROOT
        / "opencv-zoo/face_recognition_sface/face_recognition_sface_2021dec.onnx"
    )
    face_embedding_dimensions: int = 128
    face_detector_score_threshold: float = 0.9

    asr_enabled: bool = False
    asr_model_id: str = "iic/SenseVoiceSmall"
    asr_model_version: str = "SenseVoiceSmall"
    asr_model_revision: str = "unfrozen"
    asr_model_path: Path = (
        DEFAULT_MODEL_ROOT / "modelscope/iic--SenseVoiceSmall/unfrozen"
    )
    asr_runtime_id: str = "funasr"
    asr_runtime_version: str = "unconfigured"
    asr_device: str = "cuda:0"
    asr_chunk_seconds: int = 30

    def __post_init__(self) -> None:
        if not self.job_tmp_root.is_absolute():
            raise ValueError("SGX_JOB_TMP_ROOT must be an absolute path")
        if not self.persistent_root.is_absolute():
            raise ValueError("SGX_DEPLOY_ROOT must be an absolute path")
        if not self.model_root.is_absolute():
            raise ValueError("SGX_MODEL_ROOT must be an absolute path")
        if not _is_lexically_below(self.model_root, self.persistent_root):
            raise ValueError("SGX_MODEL_ROOT must stay below SGX_DEPLOY_ROOT")
        if self.adapter_profile not in {"unconfigured", "real"}:
            raise ValueError("SGX_ADAPTER_PROFILE must be unconfigured or real")
        if self.model_transport_mode != "offline_only":
            raise ValueError("SGX_MODEL_TRANSPORT_MODE must be offline_only")
        if self.allow_model_downloads:
            raise ValueError("SGX_ALLOW_MODEL_DOWNLOADS must remain false")
        _validate_bind_host(self.bind_host)
        if not 1 <= self.bind_port <= 65535:
            raise ValueError("SGX_FEATURE_PORT must be between 1 and 65535")
        for name in (
            "max_source_bytes",
            "max_text_bytes",
            "max_image_pixels",
            "max_audio_bytes",
            "max_audio_duration_ms",
            "min_audio_sample_rate_hz",
            "max_audio_sample_rate_hz",
            "max_audio_channels",
            "image_embedding_dimensions",
            "text_embedding_dimensions",
            "embedding_batch_size",
            "face_embedding_dimensions",
            "asr_chunk_seconds",
        ):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        for name in (
            "ocr_detection_model_path",
            "ocr_recognition_model_path",
            "ocr_classifier_model_path",
            "embedding_model_path",
        ):
            _validate_model_path(name, getattr(self, name), self.model_root)
        if self.face_matching_enabled:
            for name in (
                "face_detector_model_path",
                "face_embedding_model_path",
            ):
                _validate_model_path(name, getattr(self, name), self.model_root)
        if self.asr_enabled:
            _validate_model_path("asr_model_path", self.asr_model_path, self.model_root)
        if self.image_embedding_model_id != self.text_embedding_model_id:
            raise ValueError("image and text embedding must share one frozen model")
        if self.image_embedding_model_revision != self.text_embedding_model_revision:
            raise ValueError("image and text embedding revisions must match")
        if self.image_embedding_dimensions != self.text_embedding_dimensions:
            raise ValueError("image and text embedding dimensions must match")
        if self.embedding_backend not in {
            "siglip2",
            "modelscope_chinese_clip",
        }:
            raise ValueError(
                "SGX_EMBEDDING_BACKEND must be siglip2 or modelscope_chinese_clip"
            )
        if self.embedding_model_license != "Apache-2.0":
            raise ValueError(
                "the frozen embedding profiles require Apache-2.0 artifacts"
            )
        if self.face_matching_enabled and (
            self.face_detector_model_license != "MIT"
            or self.face_embedding_model_license != "Apache-2.0"
        ):
            raise ValueError(
                "the frozen OpenCV Zoo face profile requires MIT YuNet "
                "and Apache-2.0 SFace artifacts"
            )
        if self.min_audio_sample_rate_hz > self.max_audio_sample_rate_hz:
            raise ValueError(
                "SGX_MIN_AUDIO_SAMPLE_RATE_HZ must not exceed the maximum"
            )
        if self.adapter_profile == "real":
            if self.ocr_model_revision in {"", "unfrozen"}:
                raise ValueError(
                    "SGX_OCR_MODEL_REVISION must be frozen for the real profile"
                )
            if self.image_embedding_model_revision in {"", "unfrozen"}:
                raise ValueError(
                    "SGX_EMBEDDING_REVISION must be frozen for the real profile"
                )
            if self.face_matching_enabled and (
                self.face_detector_model_revision in {"", "unfrozen"}
                or self.face_embedding_model_revision in {"", "unfrozen"}
            ):
                raise ValueError(
                    "face model revisions must be frozen when matching is enabled"
                )
            if self.asr_enabled and (
                self.asr_model_revision in {"", "unfrozen"}
                or self.asr_runtime_version in {"", "unconfigured", "unfrozen"}
            ):
                raise ValueError(
                    "ASR model and runtime revisions must be frozen when enabled"
                )
            if self.asr_enabled and self.asr_device != "cuda:0":
                raise ValueError(
                    "SGX_ASR_DEVICE must be cuda:0 for the frozen profile"
                )
            if self.asr_enabled and not 1 <= self.asr_chunk_seconds <= 60:
                raise ValueError(
                    "SGX_ASR_CHUNK_SECONDS must be between 1 and 60"
                )
            if self.ocr_device != "cpu":
                raise ValueError("SGX_OCR_DEVICE must be cpu for the frozen profile")
            if self.embedding_device != "cuda:0":
                raise ValueError(
                    "SGX_EMBEDDING_DEVICE must be cuda:0 for the frozen profile"
                )
            if self.embedding_dtype != "float16":
                raise ValueError(
                    "SGX_EMBEDDING_DTYPE must be float16 for the frozen profile"
                )
            if self.embedding_batch_size != 1:
                raise ValueError(
                    "SGX_EMBEDDING_BATCH_SIZE must be 1 for the frozen profile"
                )

    @classmethod
    def from_env(cls) -> "Settings":
        persistent_root = Path(
            os.getenv("SGX_DEPLOY_ROOT", str(DEFAULT_PERSISTENT_ROOT))
        ).expanduser()
        model_root = Path(
            os.getenv("SGX_MODEL_ROOT", str(persistent_root / "shared/models"))
        ).expanduser()
        embedding_backend = os.getenv("SGX_EMBEDDING_BACKEND", "siglip2")
        default_embedding_revision = (
            "unfrozen"
            if embedding_backend == "modelscope_chinese_clip"
            else DEFAULT_SIGLIP_REVISION
        )
        embedding_revision = os.getenv(
            "SGX_EMBEDDING_REVISION", default_embedding_revision
        )
        if embedding_backend == "modelscope_chinese_clip":
            default_embedding_id = "damo/multi-modal_clip-vit-base-patch16_zh"
            default_embedding_dimensions = 512
            default_embedding_path = (
                model_root
                / "modelscope/damo--multi-modal_clip-vit-base-patch16_zh"
                / embedding_revision
            )
        else:
            default_embedding_id = "google/siglip2-base-patch16-224"
            default_embedding_dimensions = 768
            default_embedding_path = (
                model_root
                / "siglip2/google--siglip2-base-patch16-224"
                / embedding_revision
            )
        embedding_dimensions = _env_int(
            "SGX_EMBEDDING_DIM", default_embedding_dimensions
        )
        return cls(
            job_tmp_root=Path(
                os.getenv("SGX_JOB_TMP_ROOT", "/tmp/sgx-classification/jobs")
            ).expanduser(),
            bind_host=os.getenv("SGX_FEATURE_HOST", "127.0.0.1"),
            bind_port=_env_int("SGX_FEATURE_PORT", 8765),
            max_source_bytes=_env_int("SGX_MAX_SOURCE_BYTES", 25 * 1024 * 1024),
            max_text_bytes=_env_int("SGX_MAX_TEXT_BYTES", 1024 * 1024),
            max_image_pixels=_env_int("SGX_MAX_IMAGE_PIXELS", 80_000_000),
            max_audio_bytes=_env_int(
                "SGX_MAX_AUDIO_BYTES", 50 * 1024 * 1024
            ),
            max_audio_duration_ms=_env_int(
                "SGX_MAX_AUDIO_DURATION_MS", 10 * 60 * 1000
            ),
            min_audio_sample_rate_hz=_env_int(
                "SGX_MIN_AUDIO_SAMPLE_RATE_HZ", 8_000
            ),
            max_audio_sample_rate_hz=_env_int(
                "SGX_MAX_AUDIO_SAMPLE_RATE_HZ", 48_000
            ),
            max_audio_channels=_env_int("SGX_MAX_AUDIO_CHANNELS", 2),
            adapter_profile=os.getenv("SGX_ADAPTER_PROFILE", "unconfigured"),
            persistent_root=persistent_root,
            model_root=model_root,
            model_transport_mode=os.getenv(
                "SGX_MODEL_TRANSPORT_MODE", "offline_only"
            ),
            allow_model_downloads=_env_bool("SGX_ALLOW_MODEL_DOWNLOADS", False),
            release_id=os.getenv("SGX_RELEASE_ID", "unreleased"),
            git_commit=os.getenv("SGX_GIT_COMMIT", "unknown"),
            release_manifest_digest=os.getenv(
                "SGX_RELEASE_MANIFEST_DIGEST", "unknown"
            ),
            dependency_lock_digest=os.getenv("SGX_PYTHON_LOCK_DIGEST", "unknown"),
            contract_version=os.getenv(
                "SGX_FEATURE_CONTRACT_VERSION", "classification-feature-service.v1"
            ),
            ocr_model_id=os.getenv(
                "SGX_OCR_MODEL_ID", "rapidocr/PP-OCRv5-ch-mobile"
            ),
            ocr_model_version=os.getenv("SGX_OCR_RUNTIME_VERSION", "3.9.2"),
            ocr_model_revision=os.getenv("SGX_OCR_MODEL_REVISION", "unfrozen"),
            ocr_detection_model_path=Path(
                os.getenv(
                    "SGX_OCR_DET_MODEL_PATH",
                    str(
                        model_root
                        / "rapidocr/ppocrv5-mobile/ch_PP-OCRv5_det_mobile.onnx"
                    ),
                )
            ).expanduser(),
            ocr_recognition_model_path=Path(
                os.getenv(
                    "SGX_OCR_REC_MODEL_PATH",
                    str(
                        model_root
                        / "rapidocr/ppocrv5-mobile/ch_PP-OCRv5_rec_mobile.onnx"
                    ),
                )
            ).expanduser(),
            ocr_classifier_model_path=Path(
                os.getenv(
                    "SGX_OCR_CLS_MODEL_PATH",
                    str(
                        model_root
                        / "rapidocr/ppocrv5-mobile/"
                        "ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx"
                    ),
                )
            ).expanduser(),
            ocr_device=os.getenv("SGX_OCR_DEVICE", "cpu"),
            embedding_backend=embedding_backend,
            image_embedding_model_id=os.getenv(
                "SGX_IMAGE_EMBEDDING_MODEL_ID",
                default_embedding_id,
            ),
            image_embedding_model_revision=os.getenv(
                "SGX_IMAGE_EMBEDDING_REVISION",
                embedding_revision,
            ),
            image_embedding_dimensions=_env_int(
                "SGX_IMAGE_EMBEDDING_DIM", embedding_dimensions
            ),
            text_embedding_model_id=os.getenv(
                "SGX_TEXT_EMBEDDING_MODEL_ID",
                default_embedding_id,
            ),
            text_embedding_model_revision=os.getenv(
                "SGX_TEXT_EMBEDDING_REVISION",
                embedding_revision,
            ),
            text_embedding_dimensions=_env_int(
                "SGX_TEXT_EMBEDDING_DIM", embedding_dimensions
            ),
            embedding_model_license=os.getenv(
                "SGX_EMBEDDING_MODEL_LICENSE", "Apache-2.0"
            ),
            embedding_model_path=Path(
                os.getenv(
                    "SGX_EMBEDDING_MODEL_PATH",
                    str(default_embedding_path),
                )
            ).expanduser(),
            embedding_device=os.getenv("SGX_EMBEDDING_DEVICE", "cuda:0"),
            embedding_dtype=os.getenv("SGX_EMBEDDING_DTYPE", "float16"),
            embedding_batch_size=_env_int("SGX_EMBEDDING_BATCH_SIZE", 1),
            face_matching_enabled=_env_bool(
                "SGX_FACE_MATCHING_ENABLED", False
            ),
            face_detector_model_id=os.getenv(
                "SGX_FACE_DETECTOR_MODEL_ID",
                "opencv-zoo/face_detection_yunet_2023mar",
            ),
            face_detector_model_revision=os.getenv(
                "SGX_FACE_DETECTOR_MODEL_REVISION", "unfrozen"
            ),
            face_detector_model_license=os.getenv(
                "SGX_FACE_DETECTOR_MODEL_LICENSE", "MIT"
            ),
            face_detector_model_path=Path(
                os.getenv(
                    "SGX_FACE_DETECTOR_MODEL_PATH",
                    str(
                        model_root
                        / "opencv-zoo/face_detection_yunet/"
                        "face_detection_yunet_2023mar.onnx"
                    ),
                )
            ).expanduser(),
            face_embedding_model_id=os.getenv(
                "SGX_FACE_EMBEDDING_MODEL_ID",
                "opencv-zoo/face_recognition_sface_2021dec",
            ),
            face_embedding_model_revision=os.getenv(
                "SGX_FACE_EMBEDDING_MODEL_REVISION", "unfrozen"
            ),
            face_embedding_model_license=os.getenv(
                "SGX_FACE_EMBEDDING_MODEL_LICENSE", "Apache-2.0"
            ),
            face_embedding_model_path=Path(
                os.getenv(
                    "SGX_FACE_EMBEDDING_MODEL_PATH",
                    str(
                        model_root
                        / "opencv-zoo/face_recognition_sface/"
                        "face_recognition_sface_2021dec.onnx"
                    ),
                )
            ).expanduser(),
            face_embedding_dimensions=_env_int(
                "SGX_FACE_EMBEDDING_DIM", 128
            ),
            face_detector_score_threshold=_env_float(
                "SGX_FACE_DETECTOR_SCORE_THRESHOLD", 0.9
            ),
            asr_enabled=_env_bool("SGX_ASR_ENABLED", False),
            asr_model_id=os.getenv("SGX_ASR_MODEL_ID", "iic/SenseVoiceSmall"),
            asr_model_version=os.getenv(
                "SGX_ASR_MODEL_VERSION", "SenseVoiceSmall"
            ),
            asr_model_revision=os.getenv("SGX_ASR_MODEL_REVISION", "unfrozen"),
            asr_model_path=Path(
                os.getenv(
                    "SGX_ASR_MODEL_PATH",
                    str(
                        model_root
                        / "modelscope/iic--SenseVoiceSmall"
                        / os.getenv("SGX_ASR_MODEL_REVISION", "unfrozen")
                    ),
                )
            ).expanduser(),
            asr_runtime_id=os.getenv("SGX_ASR_RUNTIME_ID", "funasr"),
            asr_runtime_version=os.getenv(
                "SGX_ASR_RUNTIME_VERSION", "unconfigured"
            ),
            asr_device=os.getenv("SGX_ASR_DEVICE", "cuda:0"),
            asr_chunk_seconds=_env_int("SGX_ASR_CHUNK_SECONDS", 30),
        )
