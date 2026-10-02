# SGX Classification Worker deployment package

This directory is the reviewed input for the VirtAI T0/T1 deployment. It does not contain credentials, model weights, user media, API responses, or authoritative product state.

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
- Full-stack code creates a classification job and exposes the worker control-plane endpoints.
- The worker receives only a scoped lease and short-lived signed URLs.
- The product backend accepts a result only when lease, attempt, job, authorization, input and execution-profile revisions still match.
- OCR and embedding are internal features. The browser must not call them directly.

## Files

- `nonsecret.env.example`: reviewed non-secret configuration keys.
- `model-candidates.json`: Source Gate candidates. `status=candidate_unbenchmarked` means the model is not frozen for production.
- `release-manifest.example.json`: required provenance for an immutable release.
- `secrets.required.txt`: secret variable names only; never put values in this directory.

## Remote layout

Use only after `scripts/classification-virtai-preflight.sh` confirms `/gemini/code` is persistent and writable:

```text
/gemini/code/sgx-classification/
  releases/<git-sha>/
  current -> releases/<git-sha>
  shared/config/nonsecret.env
  shared/manifests/
  shared/wheels/
```

Job scratch space is `${TMPDIR:-/tmp}/sgx-classification/<jobId>` with mode `0700`. It is deleted after completion, cancellation or timeout.

## Deployment gates

1. Dedicated SSH public key works with `BatchMode=yes`.
2. Read-only preflight report exists.
3. Exact model revisions, hashes and licenses are recorded.
4. Python and Node dependencies are locked.
5. Offline health/version checks pass.
6. OCR and embedding zero-cost benchmarks pass.
7. Only then may the frozen paid VLM manifest execute.

## Rollback

Each release is immutable. Rollback changes only the `current` symlink to the prior verified release, restarts the worker, and verifies `/version` and `/readyz`. Product jobs remain in the product backend and are not deleted or rewritten by rollback.
