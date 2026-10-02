from __future__ import annotations

import hashlib
import importlib
import math
import os
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Protocol

from PIL import Image

from .adapters import (
    AdapterFactories,
    AsrTranscript,
    AudioPcm,
    BoundingBox,
    EmbeddingVector,
    FaceEmbedding,
    InvalidModelOutputError,
    ModelUnavailableError,
    OcrRegion,
    unconfigured_factories,
)
from .config import Settings


def _normalized_path(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _resolve_model_artifact(
    *, candidate: Path, model_root: Path, expect_directory: bool
) -> Path:
    """Resolve an offline artifact and reject path or symlink escapes."""

    lexical_root = _normalized_path(model_root)
    lexical_candidate = _normalized_path(candidate)
    try:
        relative = lexical_candidate.relative_to(lexical_root)
    except ValueError as exc:
        raise ModelUnavailableError("MODEL_PATH_OUTSIDE_ROOT") from exc
    if relative == Path("."):
        raise ModelUnavailableError("MODEL_ARTIFACT_INVALID")

    try:
        if lexical_root.is_symlink():
            raise ModelUnavailableError("MODEL_PATH_SYMLINK_FORBIDDEN")
        resolved_root = lexical_root.resolve(strict=True)
    except ModelUnavailableError:
        raise
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise ModelUnavailableError("MODEL_ROOT_UNAVAILABLE") from exc
    if not resolved_root.is_dir():
        raise ModelUnavailableError("MODEL_ROOT_UNAVAILABLE")

    current = lexical_root
    try:
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ModelUnavailableError("MODEL_PATH_SYMLINK_FORBIDDEN")
        resolved_candidate = lexical_candidate.resolve(strict=True)
    except ModelUnavailableError:
        raise
    except FileNotFoundError as exc:
        raise ModelUnavailableError("MODEL_ARTIFACT_MISSING") from exc
    except (OSError, RuntimeError) as exc:
        raise ModelUnavailableError("MODEL_ARTIFACT_INVALID") from exc

    try:
        resolved_candidate.relative_to(resolved_root)
    except ValueError as exc:
        raise ModelUnavailableError("MODEL_PATH_OUTSIDE_ROOT") from exc
    if expect_directory and not resolved_candidate.is_dir():
        raise ModelUnavailableError("MODEL_ARTIFACT_INVALID")
    if not expect_directory and not resolved_candidate.is_file():
        raise ModelUnavailableError("MODEL_ARTIFACT_INVALID")
    return resolved_candidate


class _LoadOnce:
    def __init__(self) -> None:
        self._loaded = False
        self._load_error: str | None = None
        self._load_lock = Lock()

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        with self._load_lock:
            if self._loaded:
                return
            if self._load_error is not None:
                raise ModelUnavailableError(self._load_error)
            try:
                self._load_impl()
            except ModelUnavailableError as exc:
                self._load_error = exc.code
                raise
            except Exception as exc:
                self._load_error = "MODEL_LOAD_FAILED"
                raise ModelUnavailableError("MODEL_LOAD_FAILED") from exc
            self._loaded = True

    def _load_impl(self) -> None:
        raise NotImplementedError


class RapidOcrAdapter(_LoadOnce):
    """RapidOCR 3 adapter backed only by explicit local ONNX files."""

    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self.model_id = settings.ocr_model_id
        self.model_version = settings.ocr_model_version
        self.model_revision = settings.ocr_model_revision
        self._model_root = settings.model_root
        self._detection_path = settings.ocr_detection_model_path
        self._recognition_path = settings.ocr_recognition_model_path
        self._classifier_path = settings.ocr_classifier_model_path
        self._engine: Any = None
        self._numpy: Any = None
        self._inference_lock = Lock()

    def _load_impl(self) -> None:
        detection = _resolve_model_artifact(
            candidate=self._detection_path,
            model_root=self._model_root,
            expect_directory=False,
        )
        recognition = _resolve_model_artifact(
            candidate=self._recognition_path,
            model_root=self._model_root,
            expect_directory=False,
        )
        classifier = _resolve_model_artifact(
            candidate=self._classifier_path,
            model_root=self._model_root,
            expect_directory=False,
        )
        numpy = importlib.import_module("numpy")
        rapidocr = importlib.import_module("rapidocr")
        rapidocr_typings = importlib.import_module("rapidocr.utils.typings")
        engine_type = getattr(rapidocr, "RapidOCR", None)
        ocr_version_type = getattr(rapidocr_typings, "OCRVersion", None)
        model_type = getattr(rapidocr_typings, "ModelType", None)
        if engine_type is None or ocr_version_type is None or model_type is None:
            raise ModelUnavailableError("MODEL_RUNTIME_INCOMPATIBLE")
        ppocrv5 = getattr(ocr_version_type, "PPOCRV5", None)
        mobile = getattr(model_type, "MOBILE", None)
        if ppocrv5 is None or mobile is None:
            raise ModelUnavailableError("MODEL_RUNTIME_INCOMPATIBLE")

        # These are RapidOCR v3's flattened config keys.  Supplying all three
        # model paths prevents its default-model resolver from downloading or
        # selecting an unreviewed checkpoint.  RapidOCR derives the PP-OCRv5
        # classifier input shape from the typed OCRVersion enum, so every
        # component must also be pinned to the matching version and model
        # family.  A shape-like ad-hoc parameter is ignored by RapidOCR 3.9.2.
        self._engine = engine_type(
            params={
                "Global.model_root_dir": str(self._model_root),
                "Det.model_path": str(detection),
                "Rec.model_path": str(recognition),
                "Cls.model_path": str(classifier),
                "Det.ocr_version": ppocrv5,
                "Rec.ocr_version": ppocrv5,
                "Cls.ocr_version": ppocrv5,
                "Det.model_type": mobile,
                "Rec.model_type": mobile,
                "Cls.model_type": mobile,
            }
        )
        self._numpy = numpy

    def extract(self, image: Image.Image, source_sha256: str) -> list[OcrRegion]:
        if not self.loaded or self._engine is None or self._numpy is None:
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        with self._inference_lock:
            result = self._engine(self._numpy.asarray(image))
        if result is None or getattr(result, "boxes", None) is None:
            return []
        boxes = list(result.boxes)
        texts = list(getattr(result, "txts", []))
        scores = list(getattr(result, "scores", []))
        if not (len(boxes) == len(texts) == len(scores)):
            raise InvalidModelOutputError("INVALID_OCR_OUTPUT")

        regions: list[OcrRegion] = []
        for box, text, score in zip(boxes, texts, scores, strict=True):
            try:
                points = list(box)
                xs = [float(point[0]) for point in points]
                ys = [float(point[1]) for point in points]
                left = max(0, math.floor(min(xs)))
                top = max(0, math.floor(min(ys)))
                right = min(image.width, math.ceil(max(xs)))
                bottom = min(image.height, math.ceil(max(ys)))
            except (IndexError, TypeError, ValueError) as exc:
                raise InvalidModelOutputError("INVALID_OCR_OUTPUT") from exc
            regions.append(
                OcrRegion(
                    text=str(text),
                    bounds=BoundingBox(
                        x=left,
                        y=top,
                        width=right - left,
                        height=bottom - top,
                    ),
                    model_score=float(score),
                )
            )
        return regions


class Siglip2Adapter(_LoadOnce):
    """One shared SigLIP2 instance for serialized image and text embedding."""

    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self.model_id = settings.image_embedding_model_id
        self.model_revision = settings.image_embedding_model_revision
        self.dimensions = settings.image_embedding_dimensions
        self.normalized = True
        self._model_root = settings.model_root
        self._model_path = settings.embedding_model_path
        self._device = settings.embedding_device
        self._dtype_name = settings.embedding_dtype
        self._batch_size = settings.embedding_batch_size
        self._torch: Any = None
        self._processor: Any = None
        self._model: Any = None
        self._inference_lock = Lock()

    def _load_impl(self) -> None:
        if self._batch_size != 1:
            raise ModelUnavailableError("MODEL_PROFILE_MISMATCH")
        model_path = _resolve_model_artifact(
            candidate=self._model_path,
            model_root=self._model_root,
            expect_directory=True,
        )
        torch = importlib.import_module("torch")
        transformers = importlib.import_module("transformers")
        if (
            self._device != "cuda:0"
            or not torch.cuda.is_available()
            or torch.cuda.device_count() < 1
        ):
            raise ModelUnavailableError("CUDA_DEVICE_UNAVAILABLE")
        dtype = getattr(torch, self._dtype_name, None)
        if dtype is None or self._dtype_name != "float16":
            raise ModelUnavailableError("MODEL_PROFILE_MISMATCH")

        common = {
            "local_files_only": True,
            "trust_remote_code": False,
        }
        processor = transformers.AutoProcessor.from_pretrained(
            str(model_path), **common
        )
        model = transformers.AutoModel.from_pretrained(
            str(model_path), torch_dtype=dtype, **common
        )
        model.to(device=self._device, dtype=dtype)
        model.eval()
        self._torch = torch
        self._processor = processor
        self._model = model

    def _device_inputs(self, inputs: Any) -> dict[str, Any]:
        assert self._torch is not None
        dtype = getattr(self._torch, self._dtype_name)
        output: dict[str, Any] = {}
        for name, tensor in dict(inputs).items():
            tensor = tensor.to(self._device)
            if tensor.is_floating_point():
                tensor = tensor.to(dtype=dtype)
            output[name] = tensor
        return output

    def _vector(self, features: Any) -> EmbeddingVector:
        norm = features.norm(p=2, dim=-1, keepdim=True)
        if bool((norm <= 0).any().item()):
            raise InvalidModelOutputError("INVALID_EMBEDDING_OUTPUT")
        normalized = features / norm
        rows = normalized.detach().float().cpu().tolist()
        if (
            not isinstance(rows, list)
            or len(rows) != 1
            or not isinstance(rows[0], list)
            or len(rows[0]) != self.dimensions
        ):
            raise InvalidModelOutputError("INVALID_EMBEDDING_OUTPUT")
        return EmbeddingVector(values=[float(value) for value in rows[0]])

    def embed_image(
        self, image: Image.Image, source_sha256: str
    ) -> EmbeddingVector:
        if not self.loaded or self._processor is None or self._model is None:
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        with self._inference_lock, self._torch.inference_mode():
            inputs = self._processor(images=[image], return_tensors="pt")
            features = self._model.get_image_features(**self._device_inputs(inputs))
            return self._vector(features)

    def embed_text(self, text: str, source_sha256: str) -> EmbeddingVector:
        if not self.loaded or self._processor is None or self._model is None:
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        with self._inference_lock, self._torch.inference_mode():
            inputs = self._processor(
                text=[text],
                padding="max_length",
                truncation=True,
                return_tensors="pt",
            )
            features = self._model.get_text_features(**self._device_inputs(inputs))
            return self._vector(features)


class ModelScopeChineseClipAdapter(_LoadOnce):
    """ModelScope Chinese-CLIP loaded from a reviewed local snapshot only.

    Repository Python files are rejected.  The adapter uses ModelScope's
    installed model class directly and never supplies a remote model ID to its
    loader.  It deliberately avoids ModelScope's generic pipeline and
    preprocessor registries: importing those registries pulls many unrelated
    optional packages and makes the small inference service harder to freeze.
    """

    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self.model_id = settings.image_embedding_model_id
        self.model_revision = settings.image_embedding_model_revision
        self.dimensions = settings.image_embedding_dimensions
        self.normalized = True
        self._model_root = settings.model_root
        self._model_path = settings.embedding_model_path
        self._device = settings.embedding_device
        self._dtype_name = settings.embedding_dtype
        self._batch_size = settings.embedding_batch_size
        self._torch: Any = None
        self._numpy: Any = None
        self._model: Any = None
        self._tokenizer: Any = None
        self._image_resolution: int | None = None
        self._inference_lock = Lock()

    def _load_impl(self) -> None:
        if self._batch_size != 1:
            raise ModelUnavailableError("MODEL_PROFILE_MISMATCH")
        model_path = _resolve_model_artifact(
            candidate=self._model_path,
            model_root=self._model_root,
            expect_directory=True,
        )
        if any(model_path.rglob("*.py")):
            raise ModelUnavailableError("MODEL_REPOSITORY_CODE_FORBIDDEN")
        torch = importlib.import_module("torch")
        numpy = importlib.import_module("numpy")
        clip_module = importlib.import_module(
            "modelscope.models.multi_modal.clip.model"
        )
        if (
            self._device != "cuda:0"
            or self._dtype_name != "float16"
            or not torch.cuda.is_available()
            or torch.cuda.device_count() < 1
        ):
            raise ModelUnavailableError("CUDA_DEVICE_UNAVAILABLE")
        try:
            wrapper_type = clip_module.CLIPForMultiModalEmbedding
            wrapper = wrapper_type(str(model_path))
            model = wrapper.clip_model
            model.to(self._device)
            model.eval()
            tokenizer = model.tokenizer
            image_resolution = int(model.visual.input_resolution)
        except AttributeError as exc:
            raise ModelUnavailableError("MODEL_RUNTIME_INCOMPATIBLE") from exc
        self._torch = torch
        self._numpy = numpy
        self._model = model
        self._tokenizer = tokenizer
        self._image_resolution = image_resolution

    def _vector(self, value: Any) -> EmbeddingVector:
        if hasattr(value, "detach"):
            value = value.detach().float().cpu()
        if hasattr(value, "tolist"):
            value = value.tolist()
        while isinstance(value, list) and len(value) == 1 and isinstance(
            value[0], list
        ):
            value = value[0]
        if not isinstance(value, list) or len(value) != self.dimensions:
            raise InvalidModelOutputError("INVALID_EMBEDDING_OUTPUT")
        try:
            values = [float(item) for item in value]
        except (TypeError, ValueError) as exc:
            raise InvalidModelOutputError("INVALID_EMBEDDING_OUTPUT") from exc
        norm = math.sqrt(sum(item * item for item in values))
        if not math.isfinite(norm) or norm <= 0:
            raise InvalidModelOutputError("INVALID_EMBEDDING_OUTPUT")
        return EmbeddingVector(values=[item / norm for item in values])

    def _image_tensor(self, image: Image.Image) -> Any:
        if (
            self._torch is None
            or self._numpy is None
            or self._image_resolution is None
        ):
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        resized = image.convert("RGB").resize(
            (self._image_resolution, self._image_resolution),
            resample=Image.Resampling.BICUBIC,
        )
        pixels = self._numpy.asarray(resized, dtype="float32") / 255.0
        mean = self._numpy.asarray(
            (0.48145466, 0.4578275, 0.40821073), dtype="float32"
        )
        std = self._numpy.asarray(
            (0.26862954, 0.26130258, 0.27577711), dtype="float32"
        )
        normalized = (pixels - mean) / std
        tensor = self._torch.from_numpy(normalized.transpose(2, 0, 1))
        return tensor.unsqueeze(0).to(
            device=self._device,
            dtype=getattr(self._torch, self._dtype_name),
        )

    def _text_tensor(self, text: str) -> Any:
        if self._torch is None or self._tokenizer is None:
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        context_length = 52
        try:
            token_ids = [self._tokenizer.vocab["[CLS]"]]
            token_ids.extend(
                self._tokenizer.convert_tokens_to_ids(
                    self._tokenizer.tokenize(text)
                )[: context_length - 2]
            )
            token_ids.append(self._tokenizer.vocab["[SEP]"])
        except (AttributeError, KeyError, TypeError) as exc:
            raise ModelUnavailableError("MODEL_RUNTIME_INCOMPATIBLE") from exc
        tensor = self._torch.zeros(
            (1, context_length), dtype=self._torch.long
        )
        tensor[0, : len(token_ids)] = self._torch.tensor(
            token_ids, dtype=self._torch.long
        )
        return tensor.to(self._device)

    def embed_image(
        self, image: Image.Image, source_sha256: str
    ) -> EmbeddingVector:
        if not self.loaded or self._model is None or self._torch is None:
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        with self._inference_lock, self._torch.inference_mode():
            output = self._model.encode_image(self._image_tensor(image))
        return self._vector(output)

    def embed_text(self, text: str, source_sha256: str) -> EmbeddingVector:
        if not self.loaded or self._model is None or self._torch is None:
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        with self._inference_lock, self._torch.inference_mode():
            output = self._model.encode_text(self._text_tensor(text))
        return self._vector(output)


class SenseVoiceRuntime(Protocol):
    """Audited installed runtime; it receives a local model directory only."""

    def transcribe(self, audio: AudioPcm) -> AsrTranscript: ...


SenseVoiceRuntimeFactory = Callable[[Path], SenseVoiceRuntime]


class LocalSenseVoiceSmallAdapter(_LoadOnce):
    """Fail-closed SenseVoiceSmall boundary with no model-hub loader.

    FunASR/ModelScope loading is intentionally delegated to an audited runtime
    factory because their version-specific public APIs may otherwise execute
    repository code.  The production profile supplies no factory until that
    runtime has passed target-environment review.
    """

    def __init__(
        self,
        settings: Settings,
        runtime_factory: SenseVoiceRuntimeFactory | None,
    ) -> None:
        super().__init__()
        self.model_id = settings.asr_model_id
        self.model_version = settings.asr_model_version
        self.model_revision = settings.asr_model_revision
        self.runtime_id = settings.asr_runtime_id
        self.runtime_version = settings.asr_runtime_version
        self._model_root = settings.model_root
        self._model_path = settings.asr_model_path
        self._runtime_factory = runtime_factory
        self._runtime: SenseVoiceRuntime | None = None
        self._inference_lock = Lock()

    def _load_impl(self) -> None:
        model_path = _resolve_model_artifact(
            candidate=self._model_path,
            model_root=self._model_root,
            expect_directory=True,
        )
        if any(model_path.rglob("*.py")):
            raise ModelUnavailableError("MODEL_REPOSITORY_CODE_FORBIDDEN")
        if self._runtime_factory is None:
            raise ModelUnavailableError("ADAPTER_NOT_CONFIGURED")
        runtime = self._runtime_factory(model_path)
        if runtime is None or not callable(getattr(runtime, "transcribe", None)):
            raise ModelUnavailableError("MODEL_RUNTIME_INCOMPATIBLE")
        self._runtime = runtime

    def transcribe(
        self, audio: AudioPcm, source_sha256: str
    ) -> AsrTranscript:
        if not self.loaded or self._runtime is None:
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        with self._inference_lock:
            return self._runtime.transcribe(audio)

class OpenCvZooFaceEmbeddingAdapter(_LoadOnce):
    """YuNet + SFace candidate features without identity assertions."""

    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self.detector_model_id = settings.face_detector_model_id
        self.detector_model_revision = settings.face_detector_model_revision
        self.model_id = settings.face_embedding_model_id
        self.model_revision = settings.face_embedding_model_revision
        self.dimensions = settings.face_embedding_dimensions
        self.normalized = True
        self._score_threshold = settings.face_detector_score_threshold
        self._model_root = settings.model_root
        self._detector_path = settings.face_detector_model_path
        self._embedding_path = settings.face_embedding_model_path
        self._cv2: Any = None
        self._numpy: Any = None
        self._detector: Any = None
        self._recognizer: Any = None
        self._inference_lock = Lock()

    def _load_impl(self) -> None:
        detector_path = _resolve_model_artifact(
            candidate=self._detector_path,
            model_root=self._model_root,
            expect_directory=False,
        )
        embedding_path = _resolve_model_artifact(
            candidate=self._embedding_path,
            model_root=self._model_root,
            expect_directory=False,
        )
        cv2 = importlib.import_module("cv2")
        numpy = importlib.import_module("numpy")
        try:
            detector = cv2.FaceDetectorYN.create(
                str(detector_path),
                "",
                (320, 320),
                self._score_threshold,
                0.3,
                5000,
            )
            recognizer = cv2.FaceRecognizerSF.create(str(embedding_path), "")
        except AttributeError as exc:
            raise ModelUnavailableError("MODEL_RUNTIME_INCOMPATIBLE") from exc
        self._cv2 = cv2
        self._numpy = numpy
        self._detector = detector
        self._recognizer = recognizer

    def embed_faces(
        self, image: Image.Image, source_sha256: str
    ) -> list[FaceEmbedding]:
        if (
            not self.loaded
            or self._detector is None
            or self._recognizer is None
            or self._numpy is None
            or self._cv2 is None
        ):
            raise ModelUnavailableError("MODEL_NOT_LOADED")
        rgb = self._numpy.asarray(image)
        bgr = self._cv2.cvtColor(rgb, self._cv2.COLOR_RGB2BGR)
        with self._inference_lock:
            self._detector.setInputSize((image.width, image.height))
            detected = self._detector.detect(bgr)
            faces = detected[1] if isinstance(detected, tuple) else detected
            if faces is None:
                return []
            output: list[FaceEmbedding] = []
            for index, face in enumerate(faces):
                values = list(face)
                if len(values) < 15:
                    raise InvalidModelOutputError("INVALID_FACE_OUTPUT")
                x = max(0, int(math.floor(float(values[0]))))
                y = max(0, int(math.floor(float(values[1]))))
                width = min(image.width - x, int(math.ceil(float(values[2]))))
                height = min(image.height - y, int(math.ceil(float(values[3]))))
                score = float(values[14])
                if width <= 0 or height <= 0 or not 0 <= score <= 1:
                    raise InvalidModelOutputError("INVALID_FACE_OUTPUT")
                aligned = self._recognizer.alignCrop(bgr, face)
                raw_vector = self._numpy.asarray(
                    self._recognizer.feature(aligned), dtype="float32"
                ).reshape(-1)
                if raw_vector.size != self.dimensions:
                    raise InvalidModelOutputError("INVALID_FACE_OUTPUT")
                norm = float(self._numpy.linalg.norm(raw_vector))
                if not math.isfinite(norm) or norm <= 0:
                    raise InvalidModelOutputError("INVALID_FACE_OUTPUT")
                normalized = raw_vector / norm
                detection_key = (
                    f"{source_sha256}:{index}:{x}:{y}:{width}:{height}"
                ).encode("ascii")
                output.append(
                    FaceEmbedding(
                        face_id="face_"
                        + hashlib.sha256(detection_key).hexdigest()[:32],
                        bounds=BoundingBox(
                            x=x,
                            y=y,
                            width=width,
                            height=height,
                        ),
                        vector=EmbeddingVector(
                            values=[float(value) for value in normalized.tolist()]
                        ),
                        detector_score=score,
                    )
                )
        return output


def factories_for_settings(
    settings: Settings,
    *,
    sensevoice_runtime_factory: SenseVoiceRuntimeFactory | None = None,
) -> AdapterFactories:
    """Select adapters only through the explicit, offline deployment profile."""

    if settings.adapter_profile == "unconfigured":
        return unconfigured_factories()
    if settings.adapter_profile != "real":
        raise ValueError("unsupported adapter profile")
    if settings.model_transport_mode != "offline_only" or settings.allow_model_downloads:
        raise ValueError("real adapters require an offline-only model profile")

    if settings.embedding_backend == "siglip2":
        shared_embedding: Siglip2Adapter | ModelScopeChineseClipAdapter = (
            Siglip2Adapter(settings)
        )
    elif settings.embedding_backend == "modelscope_chinese_clip":
        shared_embedding = ModelScopeChineseClipAdapter(settings)
    else:
        raise ValueError("unsupported embedding backend")
    face_factory: Callable[[], OpenCvZooFaceEmbeddingAdapter] | None = None
    if settings.face_matching_enabled:
        shared_face = OpenCvZooFaceEmbeddingAdapter(settings)
        face_factory = lambda: shared_face
    asr_factory: Callable[[], LocalSenseVoiceSmallAdapter] | None = None
    if settings.asr_enabled:
        resolved_sensevoice_factory = sensevoice_runtime_factory
        if resolved_sensevoice_factory is None:
            from .sensevoice_runtime import create_funasr_sensevoice_runtime

            def built_in_runtime_factory(model_path: Path) -> SenseVoiceRuntime:
                return create_funasr_sensevoice_runtime(
                    model_path,
                    runtime_id=settings.asr_runtime_id,
                    runtime_version=settings.asr_runtime_version,
                    device=settings.asr_device,
                    chunk_seconds=settings.asr_chunk_seconds,
                )

            resolved_sensevoice_factory = built_in_runtime_factory
        shared_asr = LocalSenseVoiceSmallAdapter(
            settings,
            runtime_factory=resolved_sensevoice_factory,
        )
        asr_factory = lambda: shared_asr
    return AdapterFactories(
        ocr=lambda: RapidOcrAdapter(settings),
        image_embedding=lambda: shared_embedding,
        text_embedding=lambda: shared_embedding,
        face_embedding=face_factory,
        asr=asr_factory,
    )
