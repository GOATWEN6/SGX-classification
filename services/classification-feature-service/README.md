# SGX classification feature service

Internal FastAPI boundary for OCR and image/text embeddings. It is designed to
run beside the classification worker and is never called by browsers or real
users.

The process starts with `SGX_ADAPTER_PROFILE=unconfigured`. Real model loading
is possible only when the operator explicitly selects
`SGX_ADAPTER_PROFILE=real` and provides reviewed local artifacts below the SGX
model root. No adapter accepts a remote model ID as its load path.

## Security and data boundary

- The process defaults to `127.0.0.1:8765` and rejects wildcard/public bind
  addresses in configuration.
- All OCR and embedding inputs are absolute local files below
  `SGX_JOB_TMP_ROOT`. Remote URLs, relative paths, path escapes and symlink
  escapes are rejected.
- Every request supplies `sourceSha256` and `sourceByteLength`; both are checked
  before decoding or model loading.
- Images must decode successfully and stay below both byte and pixel limits.
- Text must be UTF-8 and is also passed by local file reference, so household
  text does not need to appear in access logs or request bodies.
- API docs are disabled. Errors expose stable codes, not source paths or model
  exception text.

## Endpoints

```text
GET  /healthz
GET  /readyz
GET  /version
POST /internal/v1/features/ocr
POST /internal/v1/features/image-embedding
POST /internal/v1/features/text-embedding
POST /internal/v1/features/face-embeddings
POST /internal/v1/features/asr
```

`/healthz` only reports process liveness. `/readyz` never loads a model and
returns `503` until the scratch root is usable and all three injected adapters
have loaded successfully. The first request for a capability performs its one
lazy load. A failed load is not retried implicitly.

The default app has deliberately unconfigured adapters and therefore cannot
become ready. The explicit `real` profile wires frozen RapidOCR and embedding
adapters. Tests can still inject fake adapters and never download or load real
models.

Face candidate extraction is separately controlled by
`SGX_FACE_MATCHING_ENABLED`. The frozen implementation boundary is OpenCV Zoo
YuNet under its directory MIT license plus SFace under its directory
Apache-2.0 license. Its output contains a
per-detection opaque `faceId`, bounding box, normalized vector and model
provenance. It never produces a name, family relationship or confirmed person
identity; those remain product-side candidates requiring the applicable user
confirmation policy. The public InsightFace pretrained weights are not part of
this profile.

ASR is separately controlled by `SGX_ASR_ENABLED`. The current frozen boundary
accepts only local 16-bit PCM WAV input, checks path/hash/declared size, bounds
sample rate and channel count, and rejects audio over the configured duration
before model loading. Its response records model and installed-runtime
provenance. ASR text remains model-derived evidence; downstream code must not
silently replace user text with it.

SenseVoiceSmall uses the reviewed built-in `FunAsrSenseVoiceRuntime` only when
the exact runtime is `funasr==1.4.16`. It passes FunASR an absolute local model
directory, sets `trust_remote_code=False` and `disable_update=True`, rejects
model snapshots containing `.py` files, and chunks decoded PCM into bounded
30-second calls by default. The frozen target profile uses
`kaldi-native-fbank==1.22.3` for feature extraction instead of adding another
CUDA-linked `torchaudio` distribution. Any other runtime/version, non-CUDA
device or incomplete local artifact fails closed. ASR output remains evidence
for downstream classification and never silently overwrites user-authored
text.

## Request shape

```json
{
  "sourcePath": "/tmp/sgx-classification/jobs/job-123/photo.png",
  "sourceSha256": "<64 lowercase hexadecimal characters>",
  "sourceByteLength": 12345
}
```

The text-embedding endpoint uses the same shape with a UTF-8 text file.
Embedding vectors are returned only by these internal endpoints; they are not a
product-facing contract and do not prove that two items are the same event.

## Dependency locking

`requirements.in`, `requirements-ocr-cpu.in`,
`requirements-embedding-cpu.in`, `requirements-embedding-modelscope-gpu.in`,
`requirements-asr-funasr-gpu.in` and the test input file pin reviewed direct
dependencies. OCR and embedding remain separate source profiles, while the
verified internal candidate also has one unified target-environment venv. After target
`arch`, Python ABI and glibc are known, generate a complete platform-specific
lock with hashes and install from the reviewed offline wheelhouse. Do not treat
these input files as the final transitive lock.

## Local commands after dependencies are available

```bash
PYTHONPATH=src python -m pytest -q
PYTHONPATH=src python -m sgx_classification_feature_service
```

Runtime configuration includes:

```text
SGX_JOB_TMP_ROOT=/tmp/sgx-classification/jobs
SGX_FEATURE_HOST=127.0.0.1
SGX_FEATURE_PORT=8765
SGX_MAX_SOURCE_BYTES=26214400
SGX_MAX_TEXT_BYTES=1048576
SGX_MAX_IMAGE_PIXELS=80000000
SGX_MAX_MODEL_IMAGE_BYTES=921600
SGX_MAX_MODEL_IMAGE_EDGE=1600
SGX_MAX_AUDIO_BYTES=52428800
SGX_MAX_AUDIO_DURATION_MS=600000
SGX_MIN_AUDIO_SAMPLE_RATE_HZ=8000
SGX_MAX_AUDIO_SAMPLE_RATE_HZ=48000
SGX_MAX_AUDIO_CHANNELS=2
SGX_ADAPTER_PROFILE=unconfigured
SGX_DEPLOY_ROOT=/gemini/code/sgx-classification
SGX_MODEL_ROOT=/gemini/code/sgx-classification/shared/models
SGX_MODEL_TRANSPORT_MODE=offline_only
SGX_ALLOW_MODEL_DOWNLOADS=false
```

The frozen `real` profile additionally requires:

```text
SGX_OCR_DET_MODEL_PATH=<absolute .onnx path below SGX_MODEL_ROOT>
SGX_OCR_REC_MODEL_PATH=<absolute .onnx path below SGX_MODEL_ROOT>
SGX_OCR_CLS_MODEL_PATH=<absolute .onnx path below SGX_MODEL_ROOT>
SGX_EMBEDDING_BACKEND=siglip2|modelscope_chinese_clip
SGX_EMBEDDING_MODEL_PATH=<absolute local snapshot below SGX_MODEL_ROOT>
SGX_EMBEDDING_MODEL_LICENSE=Apache-2.0
SGX_EMBEDDING_DEVICE=cuda:0
SGX_EMBEDDING_DTYPE=float16
SGX_EMBEDDING_BATCH_SIZE=1
```

`siglip2` calls `AutoProcessor`/`AutoModel` with
`local_files_only=True` and `trust_remote_code=False`. The optional
`modelscope_chinese_clip` boundary accepts a local, reviewed
`damo/multi-modal_clip-vit-base-patch16_zh` snapshot and rejects repository
Python files before loading it with the installed ModelScope model class. It
does not import ModelScope's generic pipeline/preprocessor registry; the fixed
224 px image normalization and 52-token text preparation stay in this service.
The frozen base-patch16 candidate emits 512-dimensional vectors, so a release
must configure and verify that exact dimension. Both backends share one
in-process model instance for image and text embedding, serialize inference,
process exactly one item per call, and normalize vectors. The ModelScope
backend must pass its target-environment smoke test before activation.

When face candidates are enabled, these variables are also mandatory release
inputs:

```text
SGX_FACE_MATCHING_ENABLED=true
SGX_FACE_DETECTOR_MODEL_PATH=<local YuNet ONNX below SGX_MODEL_ROOT>
SGX_FACE_EMBEDDING_MODEL_PATH=<local SFace ONNX below SGX_MODEL_ROOT>
SGX_FACE_DETECTOR_MODEL_LICENSE=MIT
SGX_FACE_EMBEDDING_MODEL_LICENSE=Apache-2.0
```

Runtime path resolution rejects missing artifacts, parent traversal, model-root
escape and symlink escape. A failed model load is remembered and is not retried
implicitly; the operator must replace or restart the release deliberately.

To enable the reviewed ASR capability, release configuration also freezes:

```text
SGX_ASR_ENABLED=true
SGX_ASR_MODEL_ID=iic/SenseVoiceSmall
SGX_ASR_MODEL_VERSION=SenseVoiceSmall
SGX_ASR_MODEL_REVISION=<exact reviewed snapshot revision>
SGX_ASR_MODEL_PATH=<absolute local snapshot below SGX_MODEL_ROOT>
SGX_ASR_RUNTIME_ID=funasr
SGX_ASR_RUNTIME_VERSION=1.4.16
SGX_ASR_DEVICE=cuda:0
SGX_ASR_CHUNK_SECONDS=30
```

The built-in runtime is selected only for this exact identity. Tests may inject
a fake runtime factory, but production configuration cannot fall back to a
different version or download missing code. The target environment additionally
freezes `kaldi-native-fbank==1.22.3` and installs it from the persistent offline
wheelhouse.

## Verified target-environment boundary (2026-10-03)

The internal candidate has passed one loopback HTTP smoke on the verified
VirtAI target with every optional capability enabled in one process:

- OCR returned the expected synthetic token `2018`;
- image and text embedding returned finite, normalized 512-dimensional vectors;
- face extraction returned seven anonymous 128-dimensional candidate vectors;
- SenseVoice returned non-empty Chinese text for a 9.7-second PCM WAV;
- `/readyz` changed from `503 not_ready` before lazy loads to `200 ready` after
  every component loaded.

Evidence is stored at
`/gemini/code/sgx-classification/shared/manifests/component-smoke-feature-service-http-20261003-r2.result.json`
with SHA-256
`ba1d9babca1d8772a7b2a1f789842bc996a5f25b3e6174a2fa68cc0a510587b9`.
This proves contract execution and same-process coexistence on one target GPU.
The fixtures are synthetic, so it does not prove real-user accuracy, identity
reliability, production latency/SLA or commercial release readiness.

Release, Git, lock and model identity variables should come from the verified
release manifest. Adapter identity must match those values before a component
is marked loaded.
The first integrated OCR + face runtime freezes `opencv-python==4.11.0.86`
because RapidOCR declares that distribution directly. Do not also install
`opencv-python-headless` into the same venv: both packages provide the same
`cv2` files. A future split face-only process may use a separately frozen
headless lock.
