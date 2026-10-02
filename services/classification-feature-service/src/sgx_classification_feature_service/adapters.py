from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Callable, Generic, Protocol, TypeVar

from PIL import Image


class FeatureServiceError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ModelUnavailableError(FeatureServiceError):
    pass


class InvalidModelOutputError(FeatureServiceError):
    pass


@dataclass(frozen=True)
class BoundingBox:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class OcrRegion:
    text: str
    bounds: BoundingBox
    model_score: float | None = None


@dataclass(frozen=True)
class EmbeddingVector:
    values: list[float]


@dataclass(frozen=True)
class AudioPcm:
    pcm_s16le: bytes
    sample_rate_hz: int
    channels: int
    frame_count: int
    duration_ms: int
    format: str = "wav-pcm-s16le"


@dataclass(frozen=True)
class AsrSegment:
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class AsrTranscript:
    text: str
    language: str | None = None
    segments: list[AsrSegment] | None = None


@dataclass(frozen=True)
class FaceEmbedding:
    """One detected face for candidate clustering.

    ``face_id`` identifies this detection only.  It is deliberately not a
    person identifier and carries no name or relationship assertion.
    """

    face_id: str
    bounds: BoundingBox
    vector: EmbeddingVector
    detector_score: float | None = None


class LoadableAdapter(Protocol):
    loaded: bool

    def load(self) -> None: ...


class OcrAdapter(LoadableAdapter, Protocol):
    model_id: str
    model_version: str
    model_revision: str

    def extract(self, image: Image.Image, source_sha256: str) -> list[OcrRegion]: ...


class ImageEmbeddingAdapter(LoadableAdapter, Protocol):
    model_id: str
    model_revision: str
    dimensions: int
    normalized: bool

    def embed_image(
        self, image: Image.Image, source_sha256: str
    ) -> EmbeddingVector: ...


class TextEmbeddingAdapter(LoadableAdapter, Protocol):
    model_id: str
    model_revision: str
    dimensions: int
    normalized: bool

    def embed_text(self, text: str, source_sha256: str) -> EmbeddingVector: ...


class FaceEmbeddingAdapter(LoadableAdapter, Protocol):
    detector_model_id: str
    detector_model_revision: str
    model_id: str
    model_revision: str
    dimensions: int
    normalized: bool

    def embed_faces(
        self, image: Image.Image, source_sha256: str
    ) -> list[FaceEmbedding]: ...


class AsrAdapter(LoadableAdapter, Protocol):
    model_id: str
    model_version: str
    model_revision: str
    runtime_id: str
    runtime_version: str

    def transcribe(
        self, audio: AudioPcm, source_sha256: str
    ) -> AsrTranscript: ...


@dataclass(frozen=True)
class AdapterFactories:
    ocr: Callable[[], OcrAdapter]
    image_embedding: Callable[[], ImageEmbeddingAdapter]
    text_embedding: Callable[[], TextEmbeddingAdapter]
    face_embedding: Callable[[], FaceEmbeddingAdapter] | None = None
    asr: Callable[[], AsrAdapter] | None = None


T = TypeVar("T", bound=LoadableAdapter)


class LazyComponent(Generic[T]):
    """Loads one adapter at first use and never retries a failed load implicitly."""

    def __init__(
        self,
        factory: Callable[[], T],
        validator: Callable[[T], None],
    ) -> None:
        self._factory = factory
        self._validator = validator
        self._adapter: T | None = None
        self._load_attempted = False
        self._loading = False
        self._error_code: str | None = None
        self._lock = Lock()

    def get(self) -> T:
        with self._lock:
            if self._error_code is not None:
                raise ModelUnavailableError(self._error_code)
            if self._adapter is not None and self._adapter.loaded:
                return self._adapter
            if self._loading:
                raise ModelUnavailableError("MODEL_LOADING")
            if self._load_attempted:
                raise ModelUnavailableError("MODEL_NOT_LOADED")

            self._load_attempted = True
            self._loading = True

        try:
            adapter = self._factory()
            adapter.load()
            if not adapter.loaded:
                raise ModelUnavailableError("MODEL_NOT_LOADED")
            self._validator(adapter)
        except FeatureServiceError as exc:
            with self._lock:
                self._loading = False
                self._error_code = exc.code
            raise ModelUnavailableError(exc.code) from exc
        except Exception as exc:
            with self._lock:
                self._loading = False
                self._error_code = "MODEL_LOAD_FAILED"
            raise ModelUnavailableError("MODEL_LOAD_FAILED") from exc

        with self._lock:
            self._loading = False
            self._adapter = adapter
            return adapter

    def status(self) -> dict[str, str | bool | None]:
        with self._lock:
            if self._error_code is not None:
                return {
                    "status": "error",
                    "loaded": False,
                    "errorCode": self._error_code,
                }
            if self._loading:
                return {
                    "status": "loading",
                    "loaded": False,
                    "errorCode": None,
                }
            loaded = self._adapter is not None and self._adapter.loaded
            return {
                "status": "loaded" if loaded else "not_loaded",
                "loaded": loaded,
                "errorCode": None,
            }


def unconfigured_factories() -> AdapterFactories:
    def missing() -> LoadableAdapter:
        raise ModelUnavailableError("ADAPTER_NOT_CONFIGURED")

    return AdapterFactories(
        ocr=missing,  # type: ignore[arg-type]
        image_embedding=missing,  # type: ignore[arg-type]
        text_embedding=missing,  # type: ignore[arg-type]
        face_embedding=missing,  # type: ignore[arg-type]
        asr=missing,  # type: ignore[arg-type]
    )
