from __future__ import annotations

import importlib
import re
from pathlib import Path
from typing import Any

from .adapters import (
    AsrTranscript,
    AudioPcm,
    InvalidModelOutputError,
    ModelUnavailableError,
)


SUPPORTED_RUNTIME_ID = "funasr"
SUPPORTED_RUNTIME_VERSION = "1.4.16"
_LANGUAGE_TAG = re.compile(r"<\|(zh|en|yue|ja|ko|nospeech)\|>")


def _is_cjk(character: str) -> bool:
    return "\u3400" <= character <= "\u9fff"


def _join_chunks(chunks: list[str]) -> str:
    if not chunks:
        return ""
    joined = chunks[0]
    for chunk in chunks[1:]:
        separator = ""
        if joined and chunk and not (_is_cjk(joined[-1]) and _is_cjk(chunk[0])):
            separator = " "
        joined += separator + chunk
    return joined


class FunAsrSenseVoiceRuntime:
    """Reviewed local-only FunASR runtime for the frozen SenseVoice snapshot.

    The runtime receives decoded PCM from the service boundary, never a URL or
    product object-store path.  It constructs ``AutoModel`` with an absolute
    local directory, disables update checks and repository Python, and bounds
    each inference call by a fixed-duration chunk.
    """

    def __init__(
        self,
        model_path: Path,
        *,
        runtime_version: str,
        device: str,
        chunk_seconds: int,
    ) -> None:
        if runtime_version != SUPPORTED_RUNTIME_VERSION:
            raise ModelUnavailableError("ASR_RUNTIME_UNSUPPORTED")
        if device != "cuda:0":
            raise ModelUnavailableError("CUDA_DEVICE_UNAVAILABLE")
        if not 1 <= chunk_seconds <= 60:
            raise ModelUnavailableError("MODEL_PROFILE_MISMATCH")

        torch = importlib.import_module("torch")
        if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
            raise ModelUnavailableError("CUDA_DEVICE_UNAVAILABLE")
        numpy = importlib.import_module("numpy")
        funasr = importlib.import_module("funasr")
        postprocess_module = importlib.import_module(
            "funasr.utils.postprocess_utils"
        )
        try:
            auto_model = funasr.AutoModel
            postprocess = postprocess_module.rich_transcription_postprocess
        except AttributeError as exc:
            raise ModelUnavailableError("MODEL_RUNTIME_INCOMPATIBLE") from exc

        self._model: Any = auto_model(
            model=str(model_path),
            device=device,
            trust_remote_code=False,
            disable_update=True,
            disable_pbar=True,
            hub="ms",
            ncpu=2,
            fp16=False,
        )
        self._numpy = numpy
        self._postprocess = postprocess
        self._chunk_seconds = chunk_seconds

    def _decode_pcm(self, audio: AudioPcm) -> Any:
        raw = self._numpy.frombuffer(audio.pcm_s16le, dtype="<i2")
        expected = audio.frame_count * audio.channels
        if raw.size != expected:
            raise InvalidModelOutputError("INVALID_ASR_INPUT")
        shaped = raw.reshape(audio.frame_count, audio.channels).astype(
            "float32"
        )
        mono = shaped.mean(axis=1) if audio.channels > 1 else shaped[:, 0]
        return mono / 32768.0

    def _parse_result(self, value: Any) -> tuple[str, str | None]:
        if (
            not isinstance(value, list)
            or len(value) != 1
            or not isinstance(value[0], dict)
            or not isinstance(value[0].get("text"), str)
        ):
            raise InvalidModelOutputError("INVALID_ASR_OUTPUT")
        raw_text = value[0]["text"]
        language_match = _LANGUAGE_TAG.search(raw_text)
        language = language_match.group(1) if language_match else None
        if language == "nospeech":
            language = None
        try:
            text = self._postprocess(raw_text).strip()
        except Exception as exc:
            raise InvalidModelOutputError("INVALID_ASR_OUTPUT") from exc
        if not text:
            raise InvalidModelOutputError("INVALID_ASR_OUTPUT")
        return text, language

    def transcribe(self, audio: AudioPcm) -> AsrTranscript:
        samples = self._decode_pcm(audio)
        chunk_frames = audio.sample_rate_hz * self._chunk_seconds
        texts: list[str] = []
        languages: list[str] = []
        for start in range(0, audio.frame_count, chunk_frames):
            chunk = samples[start : start + chunk_frames]
            result = self._model.generate(
                input=chunk,
                fs=audio.sample_rate_hz,
                data_type="sound",
                language="auto",
                use_itn=True,
                batch_size=1,
            )
            text, language = self._parse_result(result)
            texts.append(text)
            if language is not None:
                languages.append(language)
        joined = _join_chunks(texts).strip()
        if not joined:
            raise InvalidModelOutputError("INVALID_ASR_OUTPUT")
        language = languages[0] if languages and len(set(languages)) == 1 else None
        return AsrTranscript(text=joined, language=language, segments=None)


def create_funasr_sensevoice_runtime(
    model_path: Path,
    *,
    runtime_id: str,
    runtime_version: str,
    device: str,
    chunk_seconds: int,
) -> FunAsrSenseVoiceRuntime:
    if runtime_id != SUPPORTED_RUNTIME_ID:
        raise ModelUnavailableError("ASR_RUNTIME_UNSUPPORTED")
    return FunAsrSenseVoiceRuntime(
        model_path,
        runtime_version=runtime_version,
        device=device,
        chunk_seconds=chunk_seconds,
    )
