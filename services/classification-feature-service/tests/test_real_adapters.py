from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from sgx_classification_feature_service.adapters import (
    AsrTranscript,
    AudioPcm,
    ModelUnavailableError,
)
from sgx_classification_feature_service.config import Settings
from sgx_classification_feature_service.real_adapters import (
    ModelScopeChineseClipAdapter,
    LocalSenseVoiceSmallAdapter,
    RapidOcrAdapter,
    Siglip2Adapter,
    _resolve_model_artifact,
    factories_for_settings,
)


def _real_settings(
    tmp_path: Path,
    *,
    backend: str = "siglip2",
    face_matching_enabled: bool = False,
    asr_enabled: bool = False,
) -> Settings:
    persistent_root = tmp_path / "sgx-classification"
    model_root = persistent_root / "shared/models"
    ocr_root = model_root / "rapidocr"
    ocr_root.mkdir(parents=True)
    detection = ocr_root / "det.onnx"
    recognition = ocr_root / "rec.onnx"
    classifier = ocr_root / "cls.onnx"
    for artifact in (detection, recognition, classifier):
        artifact.write_bytes(b"frozen-test-artifact")
    embedding = model_root / "embedding/revision-1"
    embedding.mkdir(parents=True)
    face_root = model_root / "opencv-zoo"
    face_root.mkdir()
    face_detector = face_root / "yunet.onnx"
    face_embedding = face_root / "sface.onnx"
    face_detector.write_bytes(b"frozen-yunet")
    face_embedding.write_bytes(b"frozen-sface")
    asr_model = model_root / "modelscope/iic--SenseVoiceSmall/asr-revision-1"
    asr_model.mkdir(parents=True)
    return Settings(
        adapter_profile="real",
        persistent_root=persistent_root,
        model_root=model_root,
        ocr_model_revision="ocr-revision-1",
        ocr_detection_model_path=detection,
        ocr_recognition_model_path=recognition,
        ocr_classifier_model_path=classifier,
        embedding_backend=backend,
        image_embedding_model_revision="embedding-revision-1",
        text_embedding_model_revision="embedding-revision-1",
        image_embedding_dimensions=2,
        text_embedding_dimensions=2,
        embedding_model_path=embedding,
        face_matching_enabled=face_matching_enabled,
        face_detector_model_revision="yunet-revision-1",
        face_detector_model_path=face_detector,
        face_embedding_model_revision="sface-revision-1",
        face_embedding_model_path=face_embedding,
        face_embedding_dimensions=2,
        asr_enabled=asr_enabled,
        asr_model_revision="asr-revision-1",
        asr_model_path=asr_model,
        asr_runtime_version="2.0.0",
    )


def test_settings_reject_model_root_outside_persistent_root(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="SGX_MODEL_ROOT"):
        Settings(
            persistent_root=tmp_path / "persistent",
            model_root=tmp_path / "outside",
        )


def test_settings_reject_parent_traversal_model_path(tmp_path: Path) -> None:
    persistent = tmp_path / "persistent"
    model_root = persistent / "shared/models"
    with pytest.raises(ValueError, match="SGX_MODEL_ROOT"):
        Settings(
            persistent_root=persistent,
            model_root=model_root,
            ocr_detection_model_path=model_root / "ocr/det.onnx",
            ocr_recognition_model_path=model_root / "ocr/rec.onnx",
            ocr_classifier_model_path=model_root / "ocr/cls.onnx",
            embedding_model_path=model_root / "../escaped-model",
        )


def test_unconfigured_profile_does_not_construct_real_adapters() -> None:
    factories = factories_for_settings(Settings())
    with pytest.raises(ModelUnavailableError) as captured:
        factories.ocr()
    assert captured.value.code == "ADAPTER_NOT_CONFIGURED"


def test_rapidocr_uses_only_explicit_local_model_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _real_settings(tmp_path)
    captured: dict[str, object] = {}

    class Result:
        boxes = [[[0.2, 0.4], [7.5, 0.4], [7.5, 5.2], [0.2, 5.2]]]
        txts = ["家庭合影"]
        scores = [0.91]

    class Engine:
        def __init__(self, *, params: dict[str, str]) -> None:
            captured["params"] = params

        def __call__(self, pixels: object) -> Result:
            assert pixels == "rgb-pixels"
            return Result()

    ppocrv5 = object()
    mobile = object()
    modules = {
        "numpy": SimpleNamespace(asarray=lambda image: "rgb-pixels"),
        "rapidocr": SimpleNamespace(RapidOCR=Engine),
        "rapidocr.utils.typings": SimpleNamespace(
            OCRVersion=SimpleNamespace(PPOCRV5=ppocrv5),
            ModelType=SimpleNamespace(MOBILE=mobile),
        ),
    }
    monkeypatch.setattr(
        "sgx_classification_feature_service.real_adapters.importlib.import_module",
        lambda name: modules[name],
    )

    adapter = RapidOcrAdapter(settings)
    adapter.load()
    image = Image.new("RGB", (8, 6))
    regions = adapter.extract(image, "a" * 64)

    assert captured["params"] == {
        "Global.model_root_dir": str(settings.model_root),
        "Det.model_path": str(settings.ocr_detection_model_path),
        "Rec.model_path": str(settings.ocr_recognition_model_path),
        "Cls.model_path": str(settings.ocr_classifier_model_path),
        "Det.ocr_version": ppocrv5,
        "Rec.ocr_version": ppocrv5,
        "Cls.ocr_version": ppocrv5,
        "Det.model_type": mobile,
        "Rec.model_type": mobile,
        "Cls.model_type": mobile,
    }
    assert regions[0].text == "家庭合影"
    assert regions[0].bounds.width == 8
    assert regions[0].bounds.height == 6


def test_failed_real_adapter_load_is_not_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _real_settings(tmp_path)
    attempts = 0

    class BrokenEngine:
        def __init__(self, *, params: dict[str, str]) -> None:
            nonlocal attempts
            attempts += 1
            raise RuntimeError("do not expose this message")

    modules = {
        "numpy": SimpleNamespace(asarray=lambda image: image),
        "rapidocr": SimpleNamespace(RapidOCR=BrokenEngine),
        "rapidocr.utils.typings": SimpleNamespace(
            OCRVersion=SimpleNamespace(PPOCRV5=object()),
            ModelType=SimpleNamespace(MOBILE=object()),
        ),
    }
    monkeypatch.setattr(
        "sgx_classification_feature_service.real_adapters.importlib.import_module",
        lambda name: modules[name],
    )
    adapter = RapidOcrAdapter(settings)

    for _ in range(2):
        with pytest.raises(ModelUnavailableError) as captured:
            adapter.load()
        assert captured.value.code == "MODEL_LOAD_FAILED"
    assert attempts == 1


def test_siglip_load_is_local_only_fp16_cuda_zero_and_shared(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _real_settings(tmp_path)
    processor_calls: list[tuple[str, dict[str, object]]] = []
    model_calls: list[tuple[str, dict[str, object]]] = []

    class Loader:
        def __init__(self, calls: list[tuple[str, dict[str, object]]], value: object):
            self.calls = calls
            self.value = value

        def from_pretrained(self, path: str, **kwargs: object) -> object:
            self.calls.append((path, kwargs))
            return self.value

    class Model:
        def __init__(self) -> None:
            self.to_call: dict[str, object] | None = None
            self.eval_called = False

        def to(self, **kwargs: object) -> None:
            self.to_call = kwargs

        def eval(self) -> None:
            self.eval_called = True

    model = Model()
    fp16 = object()
    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1),
        float16=fp16,
    )
    transformers = SimpleNamespace(
        AutoProcessor=Loader(processor_calls, object()),
        AutoModel=Loader(model_calls, model),
    )
    modules = {"torch": torch, "transformers": transformers}
    monkeypatch.setattr(
        "sgx_classification_feature_service.real_adapters.importlib.import_module",
        lambda name: modules[name],
    )

    factories = factories_for_settings(settings)
    image_adapter = factories.image_embedding()
    text_adapter = factories.text_embedding()
    assert image_adapter is text_adapter
    assert isinstance(image_adapter, Siglip2Adapter)
    image_adapter.load()

    expected_common = {
        "local_files_only": True,
        "trust_remote_code": False,
    }
    assert processor_calls == [(str(settings.embedding_model_path), expected_common)]
    assert model_calls == [
        (
            str(settings.embedding_model_path),
            {"torch_dtype": fp16, **expected_common},
        )
    ]
    assert model.to_call == {"device": "cuda:0", "dtype": fp16}
    assert model.eval_called is True


def test_modelscope_chinese_clip_is_a_pluggable_shared_backend(
    tmp_path: Path,
) -> None:
    settings = _real_settings(tmp_path, backend="modelscope_chinese_clip")
    factories = factories_for_settings(settings)
    image_adapter = factories.image_embedding()
    assert image_adapter is factories.text_embedding()
    assert isinstance(image_adapter, ModelScopeChineseClipAdapter)


def test_modelscope_chinese_clip_loads_direct_local_model_without_pipeline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _real_settings(tmp_path, backend="modelscope_chinese_clip")
    imported: list[str] = []
    wrapper_paths: list[str] = []

    class Tokenizer:
        vocab = {"[CLS]": 1, "[SEP]": 2}

    class ClipModel:
        def __init__(self) -> None:
            self.tokenizer = Tokenizer()
            self.visual = SimpleNamespace(input_resolution=224)
            self.to_call: str | None = None
            self.eval_called = False

        def to(self, device: str) -> None:
            self.to_call = device

        def eval(self) -> None:
            self.eval_called = True

    clip_model = ClipModel()

    class Wrapper:
        def __init__(self, model_path: str) -> None:
            wrapper_paths.append(model_path)
            self.clip_model = clip_model

    modules = {
        "torch": SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1)
        ),
        "numpy": object(),
        "modelscope.models.multi_modal.clip.model": SimpleNamespace(
            CLIPForMultiModalEmbedding=Wrapper
        ),
    }

    def import_module(name: str) -> object:
        imported.append(name)
        return modules[name]

    monkeypatch.setattr(
        "sgx_classification_feature_service.real_adapters.importlib.import_module",
        import_module,
    )
    adapter = ModelScopeChineseClipAdapter(settings)
    adapter.load()

    assert wrapper_paths == [str(settings.embedding_model_path)]
    assert clip_model.to_call == "cuda:0"
    assert clip_model.eval_called is True
    assert "modelscope.pipelines" not in imported
    assert "modelscope.preprocessors.multi_modal" not in imported


def test_embedding_profile_rejects_unreviewed_model_license(
    tmp_path: Path,
) -> None:
    settings = _real_settings(tmp_path)
    with pytest.raises(ValueError, match="Apache-2.0"):
        Settings(
            adapter_profile="real",
            persistent_root=settings.persistent_root,
            model_root=settings.model_root,
            ocr_model_revision=settings.ocr_model_revision,
            ocr_detection_model_path=settings.ocr_detection_model_path,
            ocr_recognition_model_path=settings.ocr_recognition_model_path,
            ocr_classifier_model_path=settings.ocr_classifier_model_path,
            image_embedding_model_revision=settings.image_embedding_model_revision,
            text_embedding_model_revision=settings.text_embedding_model_revision,
            embedding_model_path=settings.embedding_model_path,
            embedding_model_license="unknown",
        )


def test_modelscope_profile_rejects_repository_python_code(
    tmp_path: Path,
) -> None:
    settings = _real_settings(tmp_path, backend="modelscope_chinese_clip")
    (settings.embedding_model_path / "modeling_custom.py").write_text(
        "raise RuntimeError('must never run')", encoding="utf-8"
    )
    adapter = ModelScopeChineseClipAdapter(settings)

    with pytest.raises(ModelUnavailableError) as captured:
        adapter.load()
    assert captured.value.code == "MODEL_REPOSITORY_CODE_FORBIDDEN"


def test_face_profile_requires_exact_reviewed_licenses(tmp_path: Path) -> None:
    settings = _real_settings(tmp_path, face_matching_enabled=True)
    factories = factories_for_settings(settings)
    assert factories.face_embedding is not None

    with pytest.raises(ValueError, match="MIT YuNet and Apache-2.0 SFace"):
        Settings(
            adapter_profile="real",
            persistent_root=settings.persistent_root,
            model_root=settings.model_root,
            ocr_detection_model_path=settings.ocr_detection_model_path,
            ocr_recognition_model_path=settings.ocr_recognition_model_path,
            ocr_classifier_model_path=settings.ocr_classifier_model_path,
            ocr_model_revision=settings.ocr_model_revision,
            embedding_model_path=settings.embedding_model_path,
            image_embedding_model_revision=settings.image_embedding_model_revision,
            text_embedding_model_revision=settings.text_embedding_model_revision,
            face_matching_enabled=True,
            face_detector_model_path=settings.face_detector_model_path,
            face_embedding_model_path=settings.face_embedding_model_path,
            face_detector_model_revision=settings.face_detector_model_revision,
            face_embedding_model_revision=settings.face_embedding_model_revision,
            face_detector_model_license="unknown",
        )


def test_runtime_rejects_model_symlink_escape(tmp_path: Path) -> None:
    model_root = tmp_path / "models"
    model_root.mkdir()
    outside = tmp_path / "outside.onnx"
    outside.write_bytes(b"not-allowed")
    linked = model_root / "linked.onnx"
    try:
        linked.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation unavailable")

    with pytest.raises(ModelUnavailableError) as captured:
        _resolve_model_artifact(
            candidate=linked,
            model_root=model_root,
            expect_directory=False,
        )
    assert captured.value.code == "MODEL_PATH_SYMLINK_FORBIDDEN"


def test_real_asr_profile_fails_closed_for_unsupported_runtime(
    tmp_path: Path,
) -> None:
    settings = _real_settings(tmp_path, asr_enabled=True)
    factories = factories_for_settings(settings)
    assert factories.asr is not None
    adapter = factories.asr()
    assert isinstance(adapter, LocalSenseVoiceSmallAdapter)

    for _ in range(2):
        with pytest.raises(ModelUnavailableError) as captured:
            adapter.load()
        assert captured.value.code == "ASR_RUNTIME_UNSUPPORTED"


def test_sensevoice_runtime_factory_receives_local_directory_only(
    tmp_path: Path,
) -> None:
    settings = _real_settings(tmp_path, asr_enabled=True)
    received: list[Path] = []

    class Runtime:
        def transcribe(self, audio: AudioPcm) -> AsrTranscript:
            assert audio.duration_ms == 100
            return AsrTranscript(text="家庭聚会", language="zh", segments=[])

    def runtime_factory(model_path: Path) -> Runtime:
        received.append(model_path)
        return Runtime()

    factories = factories_for_settings(
        settings,
        sensevoice_runtime_factory=runtime_factory,
    )
    assert factories.asr is not None
    adapter = factories.asr()
    adapter.load()
    result = adapter.transcribe(
        AudioPcm(
            pcm_s16le=b"\0\0" * 1600,
            sample_rate_hz=16_000,
            channels=1,
            frame_count=1600,
            duration_ms=100,
        ),
        "a" * 64,
    )

    assert received == [settings.asr_model_path.resolve()]
    assert result.text == "家庭聚会"


def test_sensevoice_rejects_model_repository_code_before_runtime(
    tmp_path: Path,
) -> None:
    settings = _real_settings(tmp_path, asr_enabled=True)
    (settings.asr_model_path / "model.py").write_text(
        "raise RuntimeError('must never execute')", encoding="utf-8"
    )
    called = False

    def runtime_factory(model_path: Path) -> object:
        nonlocal called
        called = True
        return object()

    adapter = LocalSenseVoiceSmallAdapter(settings, runtime_factory)
    with pytest.raises(ModelUnavailableError) as captured:
        adapter.load()

    assert captured.value.code == "MODEL_REPOSITORY_CODE_FORBIDDEN"
    assert called is False
