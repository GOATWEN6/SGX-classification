# Worker-pull runtime

This directory contains the minimal Node worker for the frozen
`classification-worker-control-plane.v1` contract. It owns no product database
state and stores job inputs only below `SGX_JOB_TMP_ROOT`.

The runtime performs one attempt per lease identity and never retries a job,
download, feature request, upload or terminal report. It:

1. leases work from the product control plane;
2. heartbeats during long stages and aborts on cancel, authorization change or
   deadline expiry;
3. downloads signed artifacts into an isolated `0700` run directory and checks
   exact byte length and SHA-256;
4. writes inline text as a local `0600` file after checking its hash;
5. calls the localhost-only feature service;
6. turns the Feature Bundle into hash-bound OCR evidence and bounded embedding Top-K hints;
7. runs the compiled Stage A bridge and sparse StoryUnit organizer;
8. uploads a versioned pipeline result;
9. sends complete, fail or cancel-ack with the immutable lease identity; and
10. removes temporary files on every terminal path.

The product backend remains authoritative. It must transactionally reject a
late `complete` when job, attempt, lease, authorization, input or execution
profile no longer match. If the worker cannot determine whether a terminal
request was accepted, it does not send a contradictory second terminal state.

## Start boundary

Start `main.mjs` only from a verified immutable release. Non-secret variables
come from `../nonsecret.env.example`; `SGX_CONTROL_PLANE_TOKEN` is injected by
the process secret store. The runtime never writes configuration or secrets.
All download-related cache variables must resolve below
`/gemini/code/sgx-classification`; startup rejects model/package caches on
`/quota`. Runtime remains offline and `/quota` is limited to unpacked venvs and
generated/compiled data that can be reconstructed from persistent artifacts.

```bash
node deploy/classification-worker/runtime/main.mjs
```

`main.mjs` uses `StageAPipelineProcessor`. `LocalFeatureBundleProcessor`
produces the internal `classification-worker-feature-bundle.1`; the pipeline
processor validates its source hashes, builds derived OCR/retrieval context and
passes only file-bound JSON to `stage-a-bridge.mjs`. The bridge loads the
compiled TypeScript Stage A and StoryUnit implementation from
`SGX_CLASSIFICATION_BUILD_DIR` and returns
`classification-worker-pipeline-result.1`.

The implementation proves the reference Worker path and failure semantics. It
does not by itself prove that the product control plane exists or that every
real model artifact is releasable. Before activation, freeze the compiled
build, model/runtime provenance, dependency locks and `/readyz`/`/version`
evidence in the release manifest.
