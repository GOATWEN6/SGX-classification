from __future__ import annotations

import hashlib
import hmac
import io
import math
import os
import stat
import warnings
import wave
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image, ImageOps, UnidentifiedImageError

from .adapters import AudioPcm


class SourceValidationError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ValidatedSource:
    data: bytes
    sha256: str
    byte_length: int


@dataclass(frozen=True)
class DecodedImage:
    image: Image.Image
    format: str
    width: int
    height: int


def read_local_source(
    *,
    source_path: str,
    source_sha256: str,
    source_byte_length: int,
    job_tmp_root: Path,
    max_source_bytes: int,
) -> ValidatedSource:
    if "\x00" in source_path:
        raise SourceValidationError("INVALID_SOURCE_PATH")
    parsed = urlsplit(source_path)
    if parsed.scheme or parsed.netloc:
        raise SourceValidationError("REMOTE_SOURCE_FORBIDDEN")

    candidate_input = Path(source_path)
    if not candidate_input.is_absolute():
        raise SourceValidationError("SOURCE_PATH_MUST_BE_ABSOLUTE")
    try:
        root = job_tmp_root.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise SourceValidationError("JOB_TMP_ROOT_UNAVAILABLE") from exc
    if not root.is_dir():
        raise SourceValidationError("JOB_TMP_ROOT_UNAVAILABLE")

    try:
        candidate = candidate_input.resolve(strict=True)
        candidate.relative_to(root)
    except FileNotFoundError as exc:
        raise SourceValidationError("SOURCE_NOT_FOUND") from exc
    except (OSError, RuntimeError, ValueError) as exc:
        raise SourceValidationError("SOURCE_PATH_OUTSIDE_JOB_ROOT") from exc

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(candidate, flags)
    except FileNotFoundError as exc:
        raise SourceValidationError("SOURCE_NOT_FOUND") from exc
    except OSError as exc:
        raise SourceValidationError("SOURCE_OPEN_FAILED") from exc

    try:
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise SourceValidationError("SOURCE_NOT_REGULAR_FILE")
            if before.st_size > max_source_bytes:
                raise SourceValidationError("SOURCE_TOO_LARGE")
            if before.st_size != source_byte_length:
                raise SourceValidationError("SOURCE_SIZE_MISMATCH")
            data = stream.read(max_source_bytes + 1)
            after = os.fstat(stream.fileno())
    except SourceValidationError:
        raise
    except OSError as exc:
        raise SourceValidationError("SOURCE_READ_FAILED") from exc

    if len(data) > max_source_bytes:
        raise SourceValidationError("SOURCE_TOO_LARGE")
    if before.st_size != after.st_size or len(data) != source_byte_length:
        raise SourceValidationError("SOURCE_CHANGED_DURING_READ")

    actual_sha256 = hashlib.sha256(data).hexdigest()
    if not hmac.compare_digest(actual_sha256, source_sha256):
        raise SourceValidationError("SOURCE_HASH_MISMATCH")
    return ValidatedSource(
        data=data,
        sha256=actual_sha256,
        byte_length=len(data),
    )


def decode_image(source: ValidatedSource, max_image_pixels: int) -> DecodedImage:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(source.data)) as probe:
                image_format = probe.format or "unknown"
                width, height = probe.size
                if width <= 0 or height <= 0 or width * height > max_image_pixels:
                    raise SourceValidationError("IMAGE_DIMENSIONS_REJECTED")
                probe.verify()

            with Image.open(io.BytesIO(source.data)) as opened:
                decoded = ImageOps.exif_transpose(opened).convert("RGB")
                decoded.load()
    except SourceValidationError:
        raise
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise SourceValidationError("IMAGE_DECODE_FAILED") from exc

    return DecodedImage(
        image=decoded,
        format=image_format,
        width=decoded.width,
        height=decoded.height,
    )


def decode_utf8_text(source: ValidatedSource, max_text_bytes: int) -> str:
    if source.byte_length > max_text_bytes:
        raise SourceValidationError("TEXT_SOURCE_TOO_LARGE")
    try:
        text = source.data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SourceValidationError("TEXT_SOURCE_NOT_UTF8") from exc
    if not text.strip():
        raise SourceValidationError("TEXT_SOURCE_EMPTY")
    return text


def decode_pcm_wav(
    source: ValidatedSource,
    *,
    max_duration_ms: int,
    min_sample_rate_hz: int,
    max_sample_rate_hz: int,
    max_channels: int,
) -> AudioPcm:
    """Decode a bounded PCM WAV without invoking codecs or external tools."""

    try:
        with wave.open(io.BytesIO(source.data), "rb") as stream:
            channels = stream.getnchannels()
            sample_width = stream.getsampwidth()
            sample_rate_hz = stream.getframerate()
            frame_count = stream.getnframes()
            compression = stream.getcomptype()
            if compression != "NONE" or sample_width != 2:
                raise SourceValidationError("AUDIO_FORMAT_UNSUPPORTED")
            if channels <= 0 or channels > max_channels:
                raise SourceValidationError("AUDIO_CHANNELS_UNSUPPORTED")
            if not min_sample_rate_hz <= sample_rate_hz <= max_sample_rate_hz:
                raise SourceValidationError("AUDIO_SAMPLE_RATE_UNSUPPORTED")
            if frame_count <= 0:
                raise SourceValidationError("AUDIO_SOURCE_EMPTY")
            duration_ms = math.ceil(frame_count * 1000 / sample_rate_hz)
            if duration_ms > max_duration_ms:
                raise SourceValidationError("AUDIO_DURATION_EXCEEDED")
            pcm = stream.readframes(frame_count)
    except SourceValidationError:
        raise
    except (EOFError, OSError, ValueError, wave.Error) as exc:
        raise SourceValidationError("AUDIO_DECODE_FAILED") from exc

    expected_bytes = frame_count * channels * sample_width
    if len(pcm) != expected_bytes:
        raise SourceValidationError("AUDIO_FRAME_DATA_MISMATCH")
    return AudioPcm(
        pcm_s16le=pcm,
        sample_rate_hz=sample_rate_hz,
        channels=channels,
        frame_count=frame_count,
        duration_ms=duration_ms,
    )
