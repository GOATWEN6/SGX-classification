#!/usr/bin/env bash

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd "$TEST_DIR/.." && pwd -P)"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

assert_link() {
  local name="$1" expected="$2" actual
  [[ -L "$SGX_CLASSIFICATION_TEST_ROOT/$name" ]] || fail "missing symlink: $name"
  actual="$(readlink "$SGX_CLASSIFICATION_TEST_ROOT/$name")"
  [[ "$actual" == "$expected" ]] || fail "$name points to $actual instead of $expected"
}

for script in "$PACKAGE_ROOT"/bin/*.sh "$PACKAGE_ROOT"/tests/*.sh; do
  bash -n "$script"
done

python3 - "$PACKAGE_ROOT/tools/acquire-modelscope-snapshot.py" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
compile(source, sys.argv[1], "exec")
PY

python3 - "$PACKAGE_ROOT" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
json_files = [
    "artifact-acquisition-plan.ocr-v1.1.json",
    "artifact-acquisition-plan.face-v1.json",
    "model-candidates.json",
    "release-manifest.example.json",
    "provenance-manifest.schema.json",
    "provenance-manifest.example.json",
]
documents = {name: json.loads((root / name).read_text()) for name in json_files}

ocr_plan = documents["artifact-acquisition-plan.ocr-v1.1.json"]
assert ocr_plan["state"] == "planned_not_acquired"
assert ocr_plan["persistencePolicy"] == "classification-download-persistence.1"
assert ocr_plan["runtimeNetworkAllowed"] is False
assert ocr_plan["automaticRetries"] == 0
assert ocr_plan["upstream"]["modelLicenseMappingAtRelease"] is None
assert "HTTP 404" in ocr_plan["upstream"]["releaseLicenseGap"]
assert "PP-OCRv5" in ocr_plan["upstream"]["modelCoverageGap"]
assert len(ocr_plan["artifacts"]) == 3
for artifact in ocr_plan["artifacts"]:
    assert artifact["sourceUrl"].startswith("https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/")
    assert artifact["persistentStagingPath"].startswith("/gemini/code/sgx-classification/staging/models/")
    assert re.fullmatch(r"[0-9a-f]{64}", artifact["expectedSha256"])

face_plan = documents["artifact-acquisition-plan.face-v1.json"]
assert face_plan["state"] == "planned_not_acquired"
assert face_plan["persistencePolicy"] == "classification-download-persistence.1"
assert face_plan["runtimeNetworkAllowed"] is False
assert face_plan["automaticRetries"] == 0
assert re.fullmatch(r"[0-9a-f]{40}", face_plan["upstream"]["commit"])
assert len(face_plan["artifacts"]) == 2
assert {item["license"] for item in face_plan["artifacts"]} == {"MIT", "Apache-2.0"}
for artifact in face_plan["artifacts"]:
    assert artifact["sourceUrl"].startswith("https://media.githubusercontent.com/media/opencv/opencv_zoo/")
    assert artifact["persistentStagingPath"].startswith("/gemini/code/sgx-classification/staging/models/")
    assert artifact["gitLfsOid"] == f"sha256:{artifact['expectedSha256']}"
    assert re.fullmatch(r"[0-9a-f]{64}", artifact["expectedSha256"])
    assert artifact["expectedBytes"] > 0

candidates = documents["model-candidates.json"]["candidates"]
assert candidates
candidate_manifest = documents["model-candidates.json"]
assert candidate_manifest["status"] == "internal_release_candidate"
assert re.fullmatch(r"[0-9a-f]{64}", candidate_manifest["registry"]["sha256"])
assert re.fullmatch(r"[0-9a-f]{64}", candidate_manifest["dependencyFreeze"]["sha256"])

embedding = next(item for item in candidates if item["capability"] == "image_text_embedding")
assert embedding["selectionState"] == "internal_release_candidate"
assert embedding["model"]["modelId"] == "damo/multi-modal_clip-vit-base-patch16_zh"
assert embedding["model"]["dimensions"] == 512
assert embedding["model"]["path"].startswith(
    "/gemini/code/sgx-classification/shared/models/candidates/"
)
assert re.fullmatch(r"[0-9a-f]{64}", embedding["evidence"]["sha256"])

face = next(item for item in candidates if item["capability"] == "anonymous_face_candidate")
assert face["selectionState"] == "internal_evaluation_candidate"
assert face["models"]["detector"]["license"] == "MIT"
assert face["models"]["embedding"]["license"] == "Apache-2.0"
assert "Never use this profile for authentication" in face["productBoundary"]

asr = next(item for item in candidates if item["capability"] == "asr")
assert asr["runtime"]["version"] == "1.4.16"
assert asr["runtime"]["fbank"]["version"] == "1.22.3"
assert asr["model"]["revision"] == "7bf452403abd7353a300cd760f7adae7701c92c1"

provenance = documents["provenance-manifest.example.json"]
assert provenance["freezeState"] == "example_not_deployable"
assert any(item["artifactSha256"] is None for item in provenance["runtimePackages"])
assert all("runtimeLicense" in item for item in provenance["runtimePackages"])
assert all("modelLicense" in item and "modelCopyright" in item for item in provenance["models"])

release = documents["release-manifest.example.json"]
assert release["releaseState"] == "example_not_deployable"
assert release["verification"]["verifiedMarkerRequired"] is True
assert release["provenanceManifest"]["schema"] == provenance["schemaVersion"]

env_text = (root / "nonsecret.env.example").read_text()
for expected in (
    "CUDA_VISIBLE_DEVICES=0",
    "SGX_EMBEDDING_MAX_CONCURRENCY=1",
    "SGX_PERSISTENCE_POLICY_VERSION=classification-download-persistence.1",
    "SGX_DOWNLOAD_ROOT=/gemini/code/sgx-classification/shared/downloads",
    "HF_HOME=/gemini/code/sgx-classification/shared/cache/huggingface",
    "TRANSFORMERS_CACHE=/gemini/code/sgx-classification/shared/cache/huggingface/transformers",
    "MODELSCOPE_CACHE=/gemini/code/sgx-classification/shared/cache/modelscope",
    "PIP_CACHE_DIR=/gemini/code/sgx-classification/shared/cache/pip",
    "SGX_RUNTIME_CACHE_ROOT=/quota/sgx-classification/cache",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
    "SGX_ALLOW_MODEL_DOWNLOADS=false",
):
    assert expected in env_text
assert "SGX_D4_API_KEY=" not in env_text
assert "SGX_CONTROL_PLANE_TOKEN=" not in env_text
for name in (
    "SGX_MODEL_CACHE_ROOT",
    "HF_HOME",
    "HF_HUB_CACHE",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "MODELSCOPE_CACHE",
    "SGX_ONNX_CACHE",
    "TORCH_HOME",
    "PIP_CACHE_DIR",
    "UV_CACHE_DIR",
    "XDG_CACHE_HOME",
    "VIRTUALENV_OVERRIDE_APP_DATA",
):
    match = re.search(rf"^{name}=(.+)$", env_text, re.MULTILINE)
    assert match, name
    assert match.group(1).startswith("/gemini/code/sgx-classification/"), (name, match.group(1))
assert not re.search(r"^(?:HF_|HUGGINGFACE_|TRANSFORMERS_|MODELSCOPE_|TORCH_|PIP_|UV_|XDG_|VIRTUALENV_).*=/quota/", env_text, re.MULTILINE)

for script in (root / "bin").glob("*.sh"):
    text = script.read_text()
    command = re.compile(
        r"(?:^|[;&|()]|\$\()\s*(?:sudo\s+)?"
        r"(?:curl|wget|pip|pip3|apt|apt-get|conda|mamba|ssh|scp|systemctl)\b",
        re.MULTILINE,
    )
    assert not command.search(text), script
PY

fixture_base="$(mktemp -d "${TMPDIR:-/tmp}/sgx-classification-fixture.XXXXXX")"
case "$fixture_base" in
  "${TMPDIR:-/tmp}"/sgx-classification-fixture.*) ;;
  *) fail "unsafe fixture root: $fixture_base" ;;
esac
cleanup() {
  rm -rf "$fixture_base"
}
trap cleanup EXIT

export SGX_DEPLOY_TEST_MODE=1
export SGX_CLASSIFICATION_TEST_ROOT="$fixture_base/persistent/sgx-classification"
export SGX_CLASSIFICATION_RUNTIME_TEST_ROOT="$fixture_base/runtime/sgx-classification"
export SGX_CLASSIFICATION_SCRATCH_TEST_ROOT="$fixture_base/tmp/sgx-classification"

bash "$PACKAGE_ROOT/bin/init-layout.sh" --dry-run >/dev/null
[[ ! -e "$SGX_CLASSIFICATION_TEST_ROOT" ]] || fail 'dry-run created the layout'
[[ ! -e "$SGX_CLASSIFICATION_RUNTIME_TEST_ROOT" ]] || fail 'dry-run created the runtime layout'
[[ ! -e "$SGX_CLASSIFICATION_SCRATCH_TEST_ROOT" ]] || fail 'dry-run created the scratch layout'
bash "$PACKAGE_ROOT/bin/init-layout.sh" >/dev/null
bash "$PACKAGE_ROOT/bin/init-layout.sh" >/dev/null
for path in \
  releases \
  shared/cache/huggingface/hub \
  shared/cache/huggingface/transformers \
  shared/cache/modelscope \
  shared/cache/onnx \
  shared/cache/torch \
  shared/cache/pip \
  shared/cache/uv \
  shared/cache/xdg \
  shared/cache/virtualenv \
  shared/config \
  shared/downloads \
  shared/manifests \
  shared/models \
  shared/wheelhouse \
  shared/tools \
  staging/models \
  staging/packages; do
  [[ -d "$SGX_CLASSIFICATION_TEST_ROOT/$path" ]] || fail "layout path missing: $path"
done
for path in \
  venvs \
  cache/compiled \
  cache/generated \
  runs \
  locks \
  staging; do
  [[ -d "$SGX_CLASSIFICATION_RUNTIME_TEST_ROOT/$path" ]] || fail "runtime layout path missing: $path"
done
[[ -d "$SGX_CLASSIFICATION_SCRATCH_TEST_ROOT/jobs" ]] || fail 'scratch jobs path missing'

download_env="$({
  bash "$PACKAGE_ROOT/bin/with-persistent-download-env.sh" \
    python3 -c 'import os; print("\n".join(f"{name}={os.environ[name]}" for name in ("HF_HOME", "TRANSFORMERS_CACHE", "MODELSCOPE_CACHE", "PIP_CACHE_DIR")))'
})"
persistent_test_root="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$SGX_CLASSIFICATION_TEST_ROOT")"
for expected in \
  "HF_HOME=$persistent_test_root/shared/cache/huggingface" \
  "TRANSFORMERS_CACHE=$persistent_test_root/shared/cache/huggingface/transformers" \
  "MODELSCOPE_CACHE=$persistent_test_root/shared/cache/modelscope" \
  "PIP_CACHE_DIR=$persistent_test_root/shared/cache/pip"; do
  grep -Fqx "$expected" <<<"$download_env" || fail "persistent download wrapper omitted $expected"
done

for path in \
  "$SGX_CLASSIFICATION_TEST_ROOT" \
  "$SGX_CLASSIFICATION_TEST_ROOT/shared/cache" \
  "$SGX_CLASSIFICATION_TEST_ROOT/shared/downloads" \
  "$SGX_CLASSIFICATION_TEST_ROOT/shared/models" \
  "$SGX_CLASSIFICATION_RUNTIME_TEST_ROOT" \
  "$SGX_CLASSIFICATION_RUNTIME_TEST_ROOT/cache" \
  "$SGX_CLASSIFICATION_SCRATCH_TEST_ROOT" \
  "$SGX_CLASSIFICATION_SCRATCH_TEST_ROOT/jobs"; do
  mode="$(python3 - "$path" <<'PY'
import os
import stat
import sys

print(oct(stat.S_IMODE(os.stat(sys.argv[1], follow_symlinks=False).st_mode))[2:])
PY
)"
  [[ "$mode" == '700' ]] || fail "layout path is not mode 0700: $path"
done

sha_a='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
sha_b='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
sha_c='cccccccccccccccccccccccccccccccccccccccc'
sha_d='dddddddddddddddddddddddddddddddddddddddd'

for release in "$sha_a" "$sha_b"; do
  mkdir "$SGX_CLASSIFICATION_TEST_ROOT/releases/$release"
  : >"$SGX_CLASSIFICATION_TEST_ROOT/releases/$release/VERIFIED"
done

bash "$PACKAGE_ROOT/bin/activate-release.sh" --dry-run "$sha_a" >/dev/null
[[ ! -e "$SGX_CLASSIFICATION_TEST_ROOT/current" ]] || fail 'activation dry-run changed current'
bash "$PACKAGE_ROOT/bin/activate-release.sh" "$sha_a" >/dev/null
assert_link current "releases/$sha_a"
[[ ! -e "$SGX_CLASSIFICATION_TEST_ROOT/previous" ]] || fail 'first activation invented previous'
bash "$PACKAGE_ROOT/bin/activate-release.sh" "$sha_a" >/dev/null
assert_link current "releases/$sha_a"

bash "$PACKAGE_ROOT/bin/activate-release.sh" "$sha_b" >/dev/null
assert_link current "releases/$sha_b"
assert_link previous "releases/$sha_a"

bash "$PACKAGE_ROOT/bin/rollback-release.sh" --dry-run "$sha_a" "$sha_b" >/dev/null
assert_link current "releases/$sha_b"
assert_link previous "releases/$sha_a"
bash "$PACKAGE_ROOT/bin/rollback-release.sh" "$sha_a" "$sha_b" >/dev/null
assert_link current "releases/$sha_a"
assert_link previous "releases/$sha_b"
bash "$PACKAGE_ROOT/bin/rollback-release.sh" "$sha_a" "$sha_b" >/dev/null
assert_link current "releases/$sha_a"
assert_link previous "releases/$sha_b"

# Simulate interruption after current changed but before previous changed.
rm "$SGX_CLASSIFICATION_TEST_ROOT/current"
ln -s "releases/$sha_b" "$SGX_CLASSIFICATION_TEST_ROOT/current"
assert_link previous "releases/$sha_b"
bash "$PACKAGE_ROOT/bin/rollback-release.sh" "$sha_b" "$sha_a" >/dev/null
assert_link current "releases/$sha_b"
assert_link previous "releases/$sha_a"

mkdir "$SGX_CLASSIFICATION_TEST_ROOT/releases/$sha_c"
expect_failure bash "$PACKAGE_ROOT/bin/activate-release.sh" "$sha_c"
expect_failure bash "$PACKAGE_ROOT/bin/activate-release.sh" '../../escape'
expect_failure bash "$PACKAGE_ROOT/bin/activate-release.sh" 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

outside="$fixture_base/outside-release"
mkdir "$outside"
: >"$outside/VERIFIED"
ln -s "$outside" "$SGX_CLASSIFICATION_TEST_ROOT/releases/$sha_d"
expect_failure bash "$PACKAGE_ROOT/bin/activate-release.sh" "$sha_d"

expect_failure env SGX_DEPLOY_TEST_MODE=0 SGX_CLASSIFICATION_TEST_ROOT="$SGX_CLASSIFICATION_TEST_ROOT" \
  bash "$PACKAGE_ROOT/bin/init-layout.sh" --dry-run

expect_failure env SGX_DEPLOY_TEST_MODE=0 SGX_CLASSIFICATION_RUNTIME_TEST_ROOT="$SGX_CLASSIFICATION_RUNTIME_TEST_ROOT" \
  bash "$PACKAGE_ROOT/bin/init-layout.sh" --dry-run

unsafe_runtime="$fixture_base/not-runtime/sgx-classification"
expect_failure env SGX_CLASSIFICATION_RUNTIME_TEST_ROOT="$unsafe_runtime" \
  bash "$PACKAGE_ROOT/bin/init-layout.sh" --dry-run

printf 'PASS: deployment layout, path gates, VERIFIED activation and rollback fixtures\n'
