from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LocalSourceRequest(ApiModel):
    source_path: str = Field(min_length=1)
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_byte_length: int = Field(ge=0)


class BoundsResponse(ApiModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class OcrRegionResponse(ApiModel):
    text: str = Field(min_length=1)
    bounds: BoundsResponse
    model_score: float | None = Field(default=None, ge=0, le=1)


class OcrResponse(ApiModel):
    source_sha256: str
    source_byte_length: int
    image_format: str
    image_width: int
    image_height: int
    model_id: str
    model_version: str
    model_revision: str
    regions: list[OcrRegionResponse]


class EmbeddingResponse(ApiModel):
    source_sha256: str
    source_byte_length: int
    model_id: str
    model_revision: str
    dimensions: int = Field(gt=0)
    normalized: bool
    vector: list[float]


class FaceEmbeddingItemResponse(ApiModel):
    # Opaque ID for one detection.  It is not a person identity.
    face_id: str = Field(pattern=r"^face_[0-9a-f]{32}$")
    bounds: BoundsResponse
    detector_score: float | None = Field(default=None, ge=0, le=1)
    vector: list[float]


class FaceEmbeddingsResponse(ApiModel):
    source_sha256: str
    source_byte_length: int
    detector_model_id: str
    detector_model_revision: str
    embedding_model_id: str
    embedding_model_revision: str
    dimensions: int = Field(gt=0)
    normalized: bool
    faces: list[FaceEmbeddingItemResponse]


class AsrSegmentResponse(ApiModel):
    text: str = Field(min_length=1)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)


class AsrResponse(ApiModel):
    source_sha256: str
    source_byte_length: int
    audio_format: str
    sample_rate_hz: int = Field(gt=0)
    channels: int = Field(gt=0)
    duration_ms: int = Field(gt=0)
    model_id: str
    model_version: str
    model_revision: str
    runtime_id: str
    runtime_version: str
    text: str = Field(min_length=1)
    language: str | None = None
    segments: list[AsrSegmentResponse]


class HealthResponse(ApiModel):
    status: Literal["ok"]
    service: str
    service_version: str
    release_id: str


class ReadyResponse(ApiModel):
    status: Literal["ready", "not_ready"]
    service: str
    release_id: str
    components: dict[str, dict[str, Any]]


class ModelIdentity(ApiModel):
    model_id: str
    model_version: str | None = None
    model_revision: str
    dimensions: int | None = None


class RuntimeIdentity(ApiModel):
    runtime_id: str
    runtime_version: str


class VersionResponse(ApiModel):
    service: str
    service_version: str
    release_id: str
    git_commit: str
    release_manifest_digest: str
    dependency_lock_digest: str
    contract_version: str
    python_version: str
    platform: str
    adapter_profile: str
    embedding_backend: str
    face_matching_enabled: bool
    asr_enabled: bool
    models: dict[str, ModelIdentity]
    runtimes: dict[str, RuntimeIdentity]
