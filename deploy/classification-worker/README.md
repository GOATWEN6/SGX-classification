# SGX Classification Worker deployment package

This directory is the reviewed, non-secret input for the VirtAI T0/T1 worker deployment. It contains no credentials, model weights, user media, API responses or authoritative product state.

Authoritative design: [`docs/superpowers/specs/2026-10-02-classification-cloud-hybrid-service-spec.md`](../../docs/superpowers/specs/2026-10-02-classification-cloud-hybrid-service-spec.md).

## Product boundary

```text
user -> product frontend -> product backend -> DB/object store/lease
                                              ^
                                              |
                                   VirtAI worker pulls work
                                              |
                           OCR + embedding + selective Flash VLM
```

- Real users never connect to VirtAI or SSH.
- Full-stack code creates classification jobs and exposes the worker control-plane endpoints.
- The worker receives only a scoped lease and short-lived signed URLs.
- The product backend accepts a result only when lease, attempt, job, authorization, input and execution-profile revisions still match.
- OCR and embedding are internal features. The browser must not call them directly.

Before a `stage_a_real` job can be leased, the product control plane must load
`CLASSIFICATION_REAL_CALL_AUTHORIZATION_PATH`. The referenced JSON is a
deployment-specific, non-secret authorization receipt. It freezes the provider
and model, the cumulative `200` request / `¥25` / zero-retry cap, person-matching
permission, expiry, and the reconciled usage from all earlier real campaigns.
The checked-in `real-call-authorization.example.json` is deliberately expired.

The control plane reserves the job's full request and cost ceiling before it
changes the job from `pending` to `processing`. A successful completion or a
known pre-provider failure releases unused capacity. A cancellation or failure
whose provider usage is unknown keeps the full reservation accounted. The
ledger is stored under
`$CLASSIFICATION_LAB_DATA_DIR/real-call-authorizations/<authorizationId>` and
is shared by every T1 browser session. The API key remains only in secret
storage; neither this receipt nor the ledger contains credentials.

The Stage A worker also calls the job-scoped control-plane route
`POST /internal/v1/classification/jobs/:jobId/historical-query` after local
feature extraction. The request carries current image/text or consented face
vectors only inside the trusted Worker-to-backend boundary. The response must
follow `classification-historical-retrieval.2`: it returns authorized active
historical projections and rank order, never vectors, similarity values,
probabilities, names or family relationships. A malformed, cross-scope or
stale-authorization response stops the job before the VLM bridge; temporary
historical-service unavailability degrades historical retrieval only and leaves
current-batch classification available. The product backend remains responsible
for implementing this route and the durable index.

## Verified remote facts and current boundary

The 2026-10-02 read-only preflight established:

- Ubuntu 22.04, x86_64, glibc, Python 3.10.12;
- `/gemini/code` is persistent and writable;
- one CUDA device is visible: `B1.gpu.small`, 5.81 GiB, compute capability 8.6;
- `nvidia-smi` is an Orion wrapper, so scripts must not assume standard NVIDIA CLI output;
- direct Hugging Face access timed out; PyPI and ModelScope were reachable.

The 2026-10-04 T1 run also established that this VirtAI Notebook can terminate
long-running processes after the platform idle window (observed through
`ORION_TASK_IDLE_TIME=3600`). Re-launching the Feature Service from the frozen
venv and persistent model store required no download, but a notebook process is
not a production supervisor. Before internal users depend on this service, T2
must provide a persistent supervisor and health-based restart, or deploy the
same frozen release in an inference environment without notebook idle
termination. The Worker and Feature Service health endpoints remain the
readiness source; a PID file alone is insufficient.

These observations do not authorize a download or installation. SigLIP2 remains `pending_transport`: its exact revision must arrive through an approved transport, then its files, model copyright/license and hashes must be frozen before benchmark or activation. Reachable ModelScope/PyPI endpoints are not evidence that the named model or package has been acquired.

## Files

- `bin/init-layout.sh`: idempotently creates the fixed deployment layout.
- `bin/activate-release.sh`: atomically switches `current`, preserving the prior verified release in `previous`.
- `bin/rollback-release.sh`: compare-and-swap style rollback with an explicit target and expected current release.
- `bin/layout-lib.sh`: fail-closed path, link and `VERIFIED` checks used by the scripts.
- `nonsecret.env.example`: reviewed non-secret settings; GPU 0, embedding concurrency 1 and persistent download caches with offline runtime are the defaults.
- `model-candidates.json`: Source Gate candidates. Candidate state is not a production selection.
- `artifact-acquisition-plan.ocr-v1.1.json`: immutable RapidOCR `v3.9.2` PP-OCRv5 acquisition sources, persistent staging destinations, expected hashes and the release-tag license-document gap; its `planned_not_acquired` state is not evidence that files exist.
- `artifact-acquisition-plan.face-v1.json`: commit-pinned OpenCV Zoo YuNet/SFace sources, Git LFS identities, exact directory licenses and persistent staging destinations; it also records the SFace commercial-activation review boundary.
- `tools/acquire-modelscope-snapshot.py`: operator-only downloader for a fixed 40-character ModelScope revision. It writes directly to persistent staging, performs zero automatic retries, preserves failed partials, rejects repository Python when requested, and writes a receipt only after every declared hash and byte count passes.
- `provenance-manifest.schema.json`: separate provenance for runtime packages and model artifacts.
- `provenance-manifest.example.json`: deliberately non-deployable example with pending hashes/reviews.
- `release-manifest.example.json`: immutable release identity and references to provenance.
- `secrets.required.txt`: secret variable names only; never put values in this directory.
- `tests/deployment-scripts.test.sh`: local temporary-fixture test; it does not touch `/gemini`.

## Remote layout and strict isolation

The production scripts have three fixed SGX-only roots and reject arbitrary
root overrides. Directories are mode `0700`; symlinks are forbidden at every
managed component.

```text
/gemini/code/sgx-classification/
  releases/<full-40-character-git-sha>/
    app/
    worker/
    feature-service/
    manifests/
    VERIFIED
  current  -> releases/<verified-sha>
  previous -> releases/<verified-sha>
  shared/
    cache/                 # every downloaded package/model cache
    config/nonsecret.env
    downloads/             # source archives and acquisition receipts
    manifests/
    models/
    wheelhouse/
    tools/
  staging/                 # persistent acquisition/freeze staging
    models/
    packages/

/quota/sgx-classification/
  venvs/                 # unpacked, rebuildable environments
  cache/                 # generated/compiled runtime data only; no downloads
  runs/
  locks/
  staging/

/tmp/sgx-classification/
  jobs/<jobId>/          # bounded per-job source material
```

The persistent SeaweedFS root stores immutable releases, every downloaded byte,
verified model artifacts, wheelhouse archives, licenses, manifests and the
download caches used by Hugging Face, ModelScope, ONNX, Torch, pip and uv. It
does not contain an unpacked Python environment because target measurements
showed expensive metadata operations. The runtime root on `/quota` contains
only venvs and generated/compiled data that can be rebuilt offline from the
persistent wheelhouse and model store. Job scratch is always
`/tmp/sgx-classification/jobs/<jobId>`. Worker
code, rather than these deployment scripts, owns scratch cleanup after
completion, cancellation or timeout.

The acquisition rule is strict: a download command must target `shared/cache`,
`shared/downloads`, `shared/wheelhouse` or persistent `staging`. It must never
use `/quota` or `/tmp` as its only copy. After acquisition, freeze the exact
revision, license/model card, file list and SHA-256 values under `shared/manifests`,
promote verified files to `shared/models`, and start production runtime with
network downloads disabled. `requireRuntimeEnvironment` rejects a worker whose
download-related environment variables point outside the persistent SGX root.

Operators must run any network-capable acquisition command through
`bin/with-persistent-download-env.sh`. The wrapper exports the Hugging Face,
Transformers, ModelScope, ONNX, Torch, pip, uv, XDG and virtualenv caches below
`/gemini/code/sgx-classification`, validates the complete managed layout, and
then executes the supplied command. It does not enable downloads by itself and
does not contain credentials. Example:

```bash
/gemini/code/sgx-classification/current/deploy/classification-worker/bin/with-persistent-download-env.sh \
  python -m pip download --dest /gemini/code/sgx-classification/shared/wheelhouse <reviewed-package>
```

The scripts never install packages, access the network, read or write secrets, restart a service, modify system configuration, create a release, or create `VERIFIED`. A separate offline build/verification step must populate an immutable release and write a regular `VERIFIED` file only after its manifest, dependency locks, health checks and provenance pass.

## Layout, activation and rollback

Run from this directory on the remote host:

```bash
bash bin/init-layout.sh --dry-run
bash bin/init-layout.sh
```

`init-layout.sh` is idempotent and sets every managed directory in all three
roots to mode `0700`. It rejects a symlink at any managed layout component.

After an independently verified release exists, preview and activate it with its full lowercase Git SHA:

```bash
bash bin/activate-release.sh --dry-run 0123456789abcdef0123456789abcdef01234567
bash bin/activate-release.sh 0123456789abcdef0123456789abcdef01234567
```

Activation requires a real directory below `releases/` and a regular, non-symlink `VERIFIED` marker. `current` and `previous` targets must always be relative `releases/<sha>` links. Re-running activation for the active SHA is a no-op.

Rollback requires both the desired previous SHA and the SHA expected to be active. This prevents a stale command from rolling back a newer deployment and lets a retry repair an interruption between the two link updates:

```bash
bash bin/rollback-release.sh --dry-run aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
bash bin/rollback-release.sh aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

The scripts only switch links. The operator or supervisor must separately restart/reload the worker and verify `/version` and `/readyz`; that system action is intentionally outside this package. Product jobs remain in the product backend and are not deleted or rewritten by activation or rollback.

## Provenance and license boundary

A runtime repository or Python package license does not determine a downloaded model's license. Record them separately:

- `runtimePackages[].runtimeLicense`: code/package license, notice and package artifact hash;
- `models[].modelCopyright`: model/checkpoint copyright holder and notice review;
- `models[].modelLicense`: model/checkpoint license and commercial-use review;
- `models[].artifacts`: every acquired model file, byte size and SHA-256;
- `models[].transportState`: transport pending, acquired but unverified, or verified offline.

Do not create `VERIFIED` while a selected runtime/model has a null artifact hash, pending model legal review, unresolved transport, placeholder preprocessing, missing dependency lock, or failed offline check. The example provenance intentionally contains these blockers.

## Non-secret offline defaults

Copy `nonsecret.env.example` to `shared/config/nonsecret.env` only as a reviewed deployment step. It defaults to:

- `CUDA_VISIBLE_DEVICES=0` and `SGX_GPU_DEVICE=0`;
- OCR on CPU;
- embedding on `cuda:0`, concurrency 1 and batch size 1 for the assigned 5.81 GiB vGPU;
- Hugging Face, ModelScope, ONNX, Torch, pip, uv and generic download caches below `/gemini/code/sgx-classification/shared/cache`;
- source downloads below `shared/downloads`, wheels below `shared/wheelhouse`, and verified model artifacts below `shared/models`;
- rejected or accepted raw provider envelopes below the restricted `SGX_PROVIDER_AUDIT_DIR`, written as per-Job mode-0600 JSONL for diagnosis and never returned to clients or logs;
- only unpacked venvs and generated/compiled caches below `/quota/sgx-classification`;
- `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `SGX_ALLOW_MODEL_DOWNLOADS=false`.

Secrets remain process/secret-store inputs named in `secrets.required.txt`. They must never be appended to the non-secret file, release manifest, provenance manifest, logs or shell history.

## Deployment gates

1. Dedicated SSH public key works with `BatchMode=yes`.
2. The read-only preflight report remains attached to the release evidence.
3. Exact package/model revisions, artifact hashes and separate legal reviews are recorded.
4. Python and Node dependencies are locked and available offline.
5. Offline `/healthz`, `/readyz` and `/version` checks pass.
6. OCR and embedding zero-cost benchmarks pass on the frozen artifacts.
7. A regular `VERIFIED` marker is created by the verifier.
8. Only then may activation occur; paid VLM execution remains a separate frozen manifest and authorization.

## Local self-test

```bash
bash tests/deployment-scripts.test.sh
```

The test uses a guarded `sgx-classification-fixture.*` directory below `${TMPDIR:-/tmp}`. Production mode ignores test-root variables, and test mode rejects any path outside that fixture shape. The test checks idempotent layout, activation, rollback/retry behavior, `VERIFIED` enforcement, traversal rejection, symlink escape rejection, shell syntax and JSON invariants. It performs no network or package operation.
