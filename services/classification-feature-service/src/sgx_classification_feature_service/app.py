from __future__ import annotations

import math
import os
import platform
import sys
from typing import Any, Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .adapters import (
    AdapterFactories,
    AsrAdapter,
    FaceEmbeddingAdapter,
    ImageEmbeddingAdapter,
    InvalidModelOutputError,
    LazyComponent,
    ModelUnavailableError,
    OcrAdapter,
    TextEmbeddingAdapter,
)
from .api_models import (
    AsrResponse,
    AsrSegmentResponse,
    BoundsResponse,
    EmbeddingResponse,
    FaceEmbeddingItemResponse,
    FaceEmbeddingsResponse,
    HealthResponse,
    LocalSourceRequest,
    ModelIdentity,
    OcrRegionResponse,
    OcrResponse,
    ReadyResponse,
    RuntimeIdentity,
    VersionResponse,
)
from .config import Settings
from .real_adapters import factories_for_settings
from .sources import SourceValidationError, decode_image, decode_utf8_text, read_local_source
from .sources import decode_pcm_wav


SERVICE_NAME = "sgx-classification-feature-service"


def _http_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code})


def _source_status(code: str) -> int:
    if code == "JOB_TMP_ROOT_UNAVAILABLE":
        return 503
    if code in {
        "SOURCE_TOO_LARGE",
        "TEXT_SOURCE_TOO_LARGE",
        "AUDIO_SOURCE_TOO_LARGE",
        "AUDIO_DURATION_EXCEEDED",
    }:
        return 413
    if code in {
        "IMAGE_DECODE_FAILED",
        "IMAGE_DIMENSIONS_REJECTED",
        "TEXT_SOURCE_NOT_UTF8",
        "TEXT_SOURCE_EMPTY",
        "AUDIO_DECODE_FAILED",
        "AUDIO_FORMAT_UNSUPPORTED",
        "AUDIO_CHANNELS_UNSUPPORTED",
        "AUDIO_SAMPLE_RATE_UNSUPPORTED",
        "AUDIO_SOURCE_EMPTY",
        "AUDIO_FRAME_DATA_MISMATCH",
    }:
        return 422
    return 400


def _read_source(
    request: LocalSourceRequest,
    settings: Settings,
    *,
    max_source_bytes: int | None = None,
):
    try:
        return read_local_source(
            source_path=request.source_path,
            source_sha256=request.source_sha256,
            source_byte_length=request.source_byte_length,
            job_tmp_root=settings.job_tmp_root,
            max_source_bytes=(
                settings.max_source_bytes
                if max_source_bytes is None
                else max_source_bytes
            ),
        )
    except SourceValidationError as exc:
        raise _http_error(_source_status(exc.code), exc.code) from exc


def _component(
    factory: Callable[[], Any], validator: Callable[[Any], None]
) -> LazyComponent[Any]:
    return LazyComponent(factory, validator)


def _require_ocr_identity(settings: Settings) -> Callable[[OcrAdapter], None]:
    def validate(adapter: OcrAdapter) -> None:
        if (
            adapter.model_id != settings.ocr_model_id
            or adapter.model_version != settings.ocr_model_version
            or adapter.model_revision != settings.ocr_model_revision
        ):
            raise ModelUnavailableError("MODEL_IDENTITY_MISMATCH")

    return validate


def _require_embedding_identity(
    *, model_id: str, model_revision: str, dimensions: int
) -> Callable[[ImageEmbeddingAdapter | TextEmbeddingAdapter], None]:
    def validate(adapter: ImageEmbeddingAdapter | TextEmbeddingAdapter) -> None:
        if (
            adapter.model_id != model_id
            or adapter.model_revision != model_revision
            or adapter.dimensions != dimensions
            or not isinstance(adapter.normalized, bool)
        ):
            raise ModelUnavailableError("MODEL_IDENTITY_MISMATCH")

    return validate


def _require_face_identity(
    settings: Settings,
) -> Callable[[FaceEmbeddingAdapter], None]:
    def validate(adapter: FaceEmbeddingAdapter) -> None:
        if (
            adapter.detector_model_id != settings.face_detector_model_id
            or adapter.detector_model_revision
            != settings.face_detector_model_revision
            or adapter.model_id != settings.face_embedding_model_id
            or adapter.model_revision != settings.face_embedding_model_revision
            or adapter.dimensions != settings.face_embedding_dimensions
            or adapter.normalized is not True
        ):
            raise ModelUnavailableError("MODEL_IDENTITY_MISMATCH")

    return validate


def _require_asr_identity(settings: Settings) -> Callable[[AsrAdapter], None]:
    def validate(adapter: AsrAdapter) -> None:
        if (
            adapter.model_id != settings.asr_model_id
            or adapter.model_version != settings.asr_model_version
            or adapter.model_revision != settings.asr_model_revision
            or adapter.runtime_id != settings.asr_runtime_id
            or adapter.runtime_version != settings.asr_runtime_version
        ):
            raise ModelUnavailableError("MODEL_IDENTITY_MISMATCH")

    return validate


def _validated_vector(adapter: Any, vector: list[float]) -> list[float]:
    if (
        not isinstance(vector, list)
        or len(vector) != adapter.dimensions
        or not all(
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(float(value))
            for value in vector
        )
    ):
        raise InvalidModelOutputError("INVALID_EMBEDDING_OUTPUT")
    values = [float(value) for value in vector]
    if adapter.normalized:
        norm = math.sqrt(sum(value * value for value in values))
        if not math.isclose(norm, 1.0, rel_tol=1e-3, abs_tol=1e-3):
            raise InvalidModelOutputError("INVALID_EMBEDDING_NORMALIZATION")
    return values


def _validated_ocr_regions(
    regions: Any, *, image_width: int, image_height: int
) -> list[OcrRegionResponse]:
    if not isinstance(regions, list):
        raise InvalidModelOutputError("INVALID_OCR_OUTPUT")
    output: list[OcrRegionResponse] = []
    try:
        for region in regions:
            bounds = region.bounds
            coordinates = (bounds.x, bounds.y, bounds.width, bounds.height)
            score = region.model_score
            if (
                not isinstance(region.text, str)
                or not region.text.strip()
                or not all(
                    isinstance(value, int) and not isinstance(value, bool)
                    for value in coordinates
                )
                or bounds.x < 0
                or bounds.y < 0
                or bounds.width <= 0
                or bounds.height <= 0
                or bounds.x + bounds.width > image_width
                or bounds.y + bounds.height > image_height
                or (
                    score is not None
                    and (
                        isinstance(score, bool)
                        or not isinstance(score, (int, float))
                        or not math.isfinite(float(score))
                        or not 0 <= score <= 1
                    )
                )
            ):
                raise InvalidModelOutputError("INVALID_OCR_OUTPUT")
            output.append(
                OcrRegionResponse(
                    text=region.text,
                    bounds=BoundsResponse(
                        x=bounds.x,
                        y=bounds.y,
                        width=bounds.width,
                        height=bounds.height,
                    ),
                    model_score=float(score) if score is not None else None,
                )
            )
    except InvalidModelOutputError:
        raise
    except Exception as exc:
        raise InvalidModelOutputError("INVALID_OCR_OUTPUT") from exc
    return output


def _validated_face_embeddings(
    adapter: FaceEmbeddingAdapter,
    faces: Any,
    *,
    image_width: int,
    image_height: int,
) -> list[FaceEmbeddingItemResponse]:
    if not isinstance(faces, list):
        raise InvalidModelOutputError("INVALID_FACE_OUTPUT")
    output: list[FaceEmbeddingItemResponse] = []
    seen_ids: set[str] = set()
    try:
        for face in faces:
            bounds = face.bounds
            coordinates = (bounds.x, bounds.y, bounds.width, bounds.height)
            score = face.detector_score
            if (
                not isinstance(face.face_id, str)
                or not face.face_id.startswith("face_")
                or face.face_id in seen_ids
                or not all(
                    isinstance(value, int) and not isinstance(value, bool)
                    for value in coordinates
                )
                or bounds.x < 0
                or bounds.y < 0
                or bounds.width <= 0
                or bounds.height <= 0
                or bounds.x + bounds.width > image_width
                or bounds.y + bounds.height > image_height
                or (
                    score is not None
                    and (
                        isinstance(score, bool)
                        or not isinstance(score, (int, float))
                        or not math.isfinite(float(score))
                        or not 0 <= score <= 1
                    )
                )
            ):
                raise InvalidModelOutputError("INVALID_FACE_OUTPUT")
            values = _validated_vector(adapter, face.vector.values)
            seen_ids.add(face.face_id)
            output.append(
                FaceEmbeddingItemResponse(
                    face_id=face.face_id,
                    bounds=BoundsResponse(
                        x=bounds.x,
                        y=bounds.y,
                        width=bounds.width,
                        height=bounds.height,
                    ),
                    detector_score=(
                        float(score) if score is not None else None
                    ),
                    vector=values,
                )
            )
    except InvalidModelOutputError:
        raise
    except Exception as exc:
        raise InvalidModelOutputError("INVALID_FACE_OUTPUT") from exc
    return output


def _validated_asr_transcript(transcript: Any, duration_ms: int) -> tuple[
    str, str | None, list[AsrSegmentResponse]
]:
    try:
        text = transcript.text
        language = transcript.language
        segments = transcript.segments or []
    except Exception as exc:
        raise InvalidModelOutputError("INVALID_ASR_OUTPUT") from exc
    if (
        not isinstance(text, str)
        or not text.strip()
        or (language is not None and (not isinstance(language, str) or not language))
        or not isinstance(segments, list)
    ):
        raise InvalidModelOutputError("INVALID_ASR_OUTPUT")

    output: list[AsrSegmentResponse] = []
    previous_end = 0
    try:
        for segment in segments:
            if (
                not isinstance(segment.text, str)
                or not segment.text.strip()
                or not isinstance(segment.start_ms, int)
                or isinstance(segment.start_ms, bool)
                or not isinstance(segment.end_ms, int)
                or isinstance(segment.end_ms, bool)
                or segment.start_ms < previous_end
                or segment.start_ms < 0
                or segment.end_ms <= segment.start_ms
                or segment.end_ms > duration_ms
            ):
                raise InvalidModelOutputError("INVALID_ASR_OUTPUT")
            output.append(
                AsrSegmentResponse(
                    text=segment.text,
                    start_ms=segment.start_ms,
                    end_ms=segment.end_ms,
                )
            )
            previous_end = segment.end_ms
    except InvalidModelOutputError:
        raise
    except Exception as exc:
        raise InvalidModelOutputError("INVALID_ASR_OUTPUT") from exc
    return text, language, output


def create_app(
    *,
    settings: Settings | None = None,
    adapter_factories: AdapterFactories | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    factories = adapter_factories or factories_for_settings(settings)

    ocr = _component(factories.ocr, _require_ocr_identity(settings))
    image_embedding = _component(
        factories.image_embedding,
        _require_embedding_identity(
            model_id=settings.image_embedding_model_id,
            model_revision=settings.image_embedding_model_revision,
            dimensions=settings.image_embedding_dimensions,
        ),
    )
    text_embedding = _component(
        factories.text_embedding,
        _require_embedding_identity(
            model_id=settings.text_embedding_model_id,
            model_revision=settings.text_embedding_model_revision,
            dimensions=settings.text_embedding_dimensions,
        ),
    )
    face_embedding = None
    if settings.face_matching_enabled:
        if factories.face_embedding is None:
            raise ValueError(
                "face matching is enabled but no face adapter factory is configured"
            )
        face_embedding = _component(
            factories.face_embedding,
            _require_face_identity(settings),
        )
    asr = None
    if settings.asr_enabled:
        if factories.asr is None:
            raise ValueError("ASR is enabled but no ASR adapter factory is configured")
        asr = _component(factories.asr, _require_asr_identity(settings))

    app = FastAPI(
        title=SERVICE_NAME,
        version=settings.service_version,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/healthz", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            service=SERVICE_NAME,
            service_version=settings.service_version,
            release_id=settings.release_id,
        )

    @app.get("/readyz", response_model=ReadyResponse)
    def ready() -> JSONResponse:
        scratch_ready = (
            settings.job_tmp_root.exists()
            and settings.job_tmp_root.is_dir()
            and os.access(settings.job_tmp_root, os.R_OK | os.W_OK | os.X_OK)
        )
        components: dict[str, dict[str, Any]] = {
            "jobTmpRoot": {
                "status": "ready" if scratch_ready else "not_ready",
                "writable": scratch_ready,
            },
            "ocr": ocr.status(),
            "imageEmbedding": image_embedding.status(),
            "textEmbedding": text_embedding.status(),
            "faceEmbedding": (
                face_embedding.status()
                if face_embedding is not None
                else {
                    "status": "disabled",
                    "loaded": False,
                    "errorCode": None,
                }
            ),
            "asr": (
                asr.status()
                if asr is not None
                else {
                    "status": "disabled",
                    "loaded": False,
                    "errorCode": None,
                }
            ),
        }
        required_components = [ocr, image_embedding, text_embedding]
        if face_embedding is not None:
            required_components.append(face_embedding)
        if asr is not None:
            required_components.append(asr)
        is_ready = scratch_ready and all(
            component.status()["loaded"] for component in required_components
        )
        payload = ReadyResponse(
            status="ready" if is_ready else "not_ready",
            service=SERVICE_NAME,
            release_id=settings.release_id,
            components=components,
        )
        return JSONResponse(
            status_code=200 if is_ready else 503,
            content=payload.model_dump(by_alias=True),
        )

    @app.get("/version", response_model=VersionResponse)
    def version() -> VersionResponse:
        runtimes: dict[str, RuntimeIdentity] = {}
        models = {
            "ocr": ModelIdentity(
                model_id=settings.ocr_model_id,
                model_version=settings.ocr_model_version,
                model_revision=settings.ocr_model_revision,
            ),
            "imageEmbedding": ModelIdentity(
                model_id=settings.image_embedding_model_id,
                model_revision=settings.image_embedding_model_revision,
                dimensions=settings.image_embedding_dimensions,
            ),
            "textEmbedding": ModelIdentity(
                model_id=settings.text_embedding_model_id,
                model_revision=settings.text_embedding_model_revision,
                dimensions=settings.text_embedding_dimensions,
            ),
        }
        if settings.face_matching_enabled:
            models["faceDetector"] = ModelIdentity(
                model_id=settings.face_detector_model_id,
                model_revision=settings.face_detector_model_revision,
            )
            models["faceEmbedding"] = ModelIdentity(
                model_id=settings.face_embedding_model_id,
                model_revision=settings.face_embedding_model_revision,
                dimensions=settings.face_embedding_dimensions,
            )
        if settings.asr_enabled:
            models["asr"] = ModelIdentity(
                model_id=settings.asr_model_id,
                model_version=settings.asr_model_version,
                model_revision=settings.asr_model_revision,
            )
            runtimes["asr"] = RuntimeIdentity(
                runtime_id=settings.asr_runtime_id,
                runtime_version=settings.asr_runtime_version,
            )
        return VersionResponse(
            service=SERVICE_NAME,
            service_version=settings.service_version,
            release_id=settings.release_id,
            git_commit=settings.git_commit,
            release_manifest_digest=settings.release_manifest_digest,
            dependency_lock_digest=settings.dependency_lock_digest,
            contract_version=settings.contract_version,
            python_version=platform.python_version(),
            platform=f"{sys.platform}-{platform.machine()}",
            adapter_profile=settings.adapter_profile,
            embedding_backend=settings.embedding_backend,
            face_matching_enabled=settings.face_matching_enabled,
            asr_enabled=settings.asr_enabled,
            models=models,
            runtimes=runtimes,
        )

    @app.post("/internal/v1/features/ocr", response_model=OcrResponse)
    def extract_ocr(request: LocalSourceRequest) -> OcrResponse:
        source = _read_source(request, settings)
        try:
            decoded = decode_image(source, settings.max_image_pixels)
        except SourceValidationError as exc:
            raise _http_error(_source_status(exc.code), exc.code) from exc
        try:
            adapter = ocr.get()
            regions = adapter.extract(decoded.image, source.sha256)
        except ModelUnavailableError as exc:
            raise _http_error(503, exc.code) from exc
        except InvalidModelOutputError as exc:
            raise _http_error(500, exc.code) from exc
        except Exception as exc:
            raise _http_error(500, "OCR_INFERENCE_FAILED") from exc
        finally:
            decoded.image.close()

        try:
            output_regions = _validated_ocr_regions(
                regions,
                image_width=decoded.width,
                image_height=decoded.height,
            )
        except InvalidModelOutputError as exc:
            raise _http_error(500, exc.code) from exc

        return OcrResponse(
            source_sha256=source.sha256,
            source_byte_length=source.byte_length,
            image_format=decoded.format,
            image_width=decoded.width,
            image_height=decoded.height,
            model_id=adapter.model_id,
            model_version=adapter.model_version,
            model_revision=adapter.model_revision,
            regions=output_regions,
        )

    @app.post(
        "/internal/v1/features/image-embedding",
        response_model=EmbeddingResponse,
    )
    def embed_image(request: LocalSourceRequest) -> EmbeddingResponse:
        source = _read_source(request, settings)
        try:
            decoded = decode_image(source, settings.max_image_pixels)
        except SourceValidationError as exc:
            raise _http_error(_source_status(exc.code), exc.code) from exc
        try:
            adapter = image_embedding.get()
            result = adapter.embed_image(decoded.image, source.sha256)
            values = _validated_vector(adapter, result.values)
        except ModelUnavailableError as exc:
            raise _http_error(503, exc.code) from exc
        except InvalidModelOutputError as exc:
            raise _http_error(500, exc.code) from exc
        except Exception as exc:
            raise _http_error(500, "IMAGE_EMBEDDING_FAILED") from exc
        finally:
            decoded.image.close()

        return EmbeddingResponse(
            source_sha256=source.sha256,
            source_byte_length=source.byte_length,
            model_id=adapter.model_id,
            model_revision=adapter.model_revision,
            dimensions=adapter.dimensions,
            normalized=adapter.normalized,
            vector=values,
        )

    @app.post(
        "/internal/v1/features/text-embedding",
        response_model=EmbeddingResponse,
    )
    def embed_text(request: LocalSourceRequest) -> EmbeddingResponse:
        source = _read_source(request, settings)
        try:
            text = decode_utf8_text(source, settings.max_text_bytes)
        except SourceValidationError as exc:
            raise _http_error(_source_status(exc.code), exc.code) from exc
        try:
            adapter = text_embedding.get()
            result = adapter.embed_text(text, source.sha256)
            values = _validated_vector(adapter, result.values)
        except ModelUnavailableError as exc:
            raise _http_error(503, exc.code) from exc
        except InvalidModelOutputError as exc:
            raise _http_error(500, exc.code) from exc
        except Exception as exc:
            raise _http_error(500, "TEXT_EMBEDDING_FAILED") from exc

        return EmbeddingResponse(
            source_sha256=source.sha256,
            source_byte_length=source.byte_length,
            model_id=adapter.model_id,
            model_revision=adapter.model_revision,
            dimensions=adapter.dimensions,
            normalized=adapter.normalized,
            vector=values,
        )

    @app.post(
        "/internal/v1/features/face-embeddings",
        response_model=FaceEmbeddingsResponse,
    )
    def embed_faces(request: LocalSourceRequest) -> FaceEmbeddingsResponse:
        if face_embedding is None:
            raise _http_error(409, "FACE_MATCHING_DISABLED")
        source = _read_source(request, settings)
        try:
            decoded = decode_image(source, settings.max_image_pixels)
        except SourceValidationError as exc:
            raise _http_error(_source_status(exc.code), exc.code) from exc
        try:
            adapter = face_embedding.get()
            result = adapter.embed_faces(decoded.image, source.sha256)
            faces = _validated_face_embeddings(
                adapter,
                result,
                image_width=decoded.width,
                image_height=decoded.height,
            )
        except ModelUnavailableError as exc:
            raise _http_error(503, exc.code) from exc
        except InvalidModelOutputError as exc:
            raise _http_error(500, exc.code) from exc
        except Exception as exc:
            raise _http_error(500, "FACE_EMBEDDING_FAILED") from exc
        finally:
            decoded.image.close()

        return FaceEmbeddingsResponse(
            source_sha256=source.sha256,
            source_byte_length=source.byte_length,
            detector_model_id=adapter.detector_model_id,
            detector_model_revision=adapter.detector_model_revision,
            embedding_model_id=adapter.model_id,
            embedding_model_revision=adapter.model_revision,
            dimensions=adapter.dimensions,
            normalized=adapter.normalized,
            faces=faces,
        )

    @app.post("/internal/v1/features/asr", response_model=AsrResponse)
    def transcribe_audio(request: LocalSourceRequest) -> AsrResponse:
        if asr is None:
            raise _http_error(409, "ASR_DISABLED")
        if request.source_byte_length > settings.max_audio_bytes:
            raise _http_error(413, "AUDIO_SOURCE_TOO_LARGE")
        source = _read_source(
            request,
            settings,
            max_source_bytes=settings.max_audio_bytes,
        )
        try:
            audio = decode_pcm_wav(
                source,
                max_duration_ms=settings.max_audio_duration_ms,
                min_sample_rate_hz=settings.min_audio_sample_rate_hz,
                max_sample_rate_hz=settings.max_audio_sample_rate_hz,
                max_channels=settings.max_audio_channels,
            )
        except SourceValidationError as exc:
            raise _http_error(_source_status(exc.code), exc.code) from exc
        try:
            adapter = asr.get()
            result = adapter.transcribe(audio, source.sha256)
            text, language, segments = _validated_asr_transcript(
                result, audio.duration_ms
            )
        except ModelUnavailableError as exc:
            raise _http_error(503, exc.code) from exc
        except InvalidModelOutputError as exc:
            raise _http_error(500, exc.code) from exc
        except Exception as exc:
            raise _http_error(500, "ASR_INFERENCE_FAILED") from exc

        return AsrResponse(
            source_sha256=source.sha256,
            source_byte_length=source.byte_length,
            audio_format=audio.format,
            sample_rate_hz=audio.sample_rate_hz,
            channels=audio.channels,
            duration_ms=audio.duration_ms,
            model_id=adapter.model_id,
            model_version=adapter.model_version,
            model_revision=adapter.model_revision,
            runtime_id=adapter.runtime_id,
            runtime_version=adapter.runtime_version,
            text=text,
            language=language,
            segments=segments,
        )

    return app


app = create_app()
