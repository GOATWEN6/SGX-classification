from __future__ import annotations

import importlib
import re
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

from sgx_classification_feature_service.adapters import (
    AudioPcm,
    InvalidModelOutputError,
    ModelUnavailableError,
)
from sgx_classification_feature_service.sensevoice_runtime import (
    FunAsrSenseVoiceRuntime,
    create_funasr_sensevoice_runtime,
)


class _FakeAutoModel:
    instances: list["_FakeAutoModel"] = []
    outputs: list[object] = []

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.calls: list[dict[str, object]] = []
        self.__class__.instances.append(self)

    def generate(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        return self.__class__.outputs.pop(0)


def _install_fake_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    original_import = importlib.import_module
    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1)
    )
    funasr = SimpleNamespace(AutoModel=_FakeAutoModel)
    postprocess = SimpleNamespace(
        rich_transcription_postprocess=lambda value: re.sub(
            r"<\|[^|]+\|>", "", value
        )
    )

    def fake_import(name: str) -> object:
        if name == "torch":
            return torch
        if name == "funasr":
            return funasr
        if name == "funasr.utils.postprocess_utils":
            return postprocess
        return original_import(name)

    monkeypatch.setattr(
        "sgx_classification_feature_service.sensevoice_runtime.importlib.import_module",
        fake_import,
    )


def _audio(*, frames: int, sample_rate: int = 8_000, channels: int = 1) -> AudioPcm:
    values = [1000] * (frames * channels)
    return AudioPcm(
        pcm_s16le=struct.pack(f"<{len(values)}h", *values),
        sample_rate_hz=sample_rate,
        channels=channels,
        frame_count=frames,
        duration_ms=round(frames * 1000 / sample_rate),
    )


def test_runtime_uses_local_model_and_chunks_pcm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _FakeAutoModel.instances.clear()
    _FakeAutoModel.outputs = [
        [{"text": "<|zh|><|NEUTRAL|><|Speech|>家庭"}],
        [{"text": "<|zh|><|NEUTRAL|><|Speech|>聚会"}],
        [{"text": "<|zh|><|NEUTRAL|><|Speech|>结束"}],
    ]
    _install_fake_runtime(monkeypatch)
    model_path = tmp_path / "sensevoice"
    runtime = FunAsrSenseVoiceRuntime(
        model_path,
        runtime_version="1.4.16",
        device="cuda:0",
        chunk_seconds=1,
    )

    transcript = runtime.transcribe(_audio(frames=17_000))

    assert transcript.text == "家庭聚会结束"
    assert transcript.language == "zh"
    assert transcript.segments is None
    model = _FakeAutoModel.instances[0]
    assert model.kwargs == {
        "model": str(model_path),
        "device": "cuda:0",
        "trust_remote_code": False,
        "disable_update": True,
        "disable_pbar": True,
        "hub": "ms",
        "ncpu": 2,
        "fp16": False,
    }
    assert [call["input"].size for call in model.calls] == [8_000, 8_000, 1_000]
    assert all(call["fs"] == 8_000 for call in model.calls)


def test_runtime_rejects_invalid_model_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _FakeAutoModel.instances.clear()
    _FakeAutoModel.outputs = [[]]
    _install_fake_runtime(monkeypatch)
    runtime = FunAsrSenseVoiceRuntime(
        tmp_path / "sensevoice",
        runtime_version="1.4.16",
        device="cuda:0",
        chunk_seconds=30,
    )

    with pytest.raises(InvalidModelOutputError) as captured:
        runtime.transcribe(_audio(frames=800))
    assert captured.value.code == "INVALID_ASR_OUTPUT"


def test_factory_rejects_unreviewed_runtime_before_import(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError) as captured:
        create_funasr_sensevoice_runtime(
            tmp_path / "sensevoice",
            runtime_id="other-runtime",
            runtime_version="1.4.16",
            device="cuda:0",
            chunk_seconds=30,
        )
    assert captured.value.code == "ASR_RUNTIME_UNSUPPORTED"
