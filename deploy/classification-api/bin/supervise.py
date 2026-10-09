#!/usr/bin/env python3
"""Manage the isolated API and feature processes without a notebook or systemd."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path('/gemini/code/sgx-classification')
RUNTIME = Path('/quota/sgx-classification')


def settings(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, raw = line.partition('=')
        if not separator or not key.replace('_', '').isalnum():
            raise ValueError('CONFIG_INVALID')
        values = shlex.split(raw, comments=True)
        if len(values) > 1:
            raise ValueError('CONFIG_VALUE_INVALID')
        result[key] = values[0] if values else ''
    return result


def probe(port: int, route: str) -> dict | None:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}', timeout=3) as response:
            return json.loads(response.read())
    except (OSError, ValueError, urllib.error.URLError):
        return None


def record(event: str, **fields) -> None:
    print(json.dumps({'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                      'event': event, **fields}), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    release = ROOT / 'releases' / args.release
    if len(args.release) != 40 or any(c not in '0123456789abcdef' for c in args.release):
        raise SystemExit('RELEASE_INVALID')
    if not (release / 'VERIFIED').is_file() or (ROOT / 'current').resolve() != release:
        raise SystemExit('RELEASE_NOT_ACTIVE')
    os.umask(0o077)
    run_root = RUNTIME / 'runs'
    run_root.mkdir(parents=True, exist_ok=True)
    # flock is on the local runtime ext4, not on the persistent FUSE filesystem.
    import fcntl
    lock = (run_root / 'direct-supervisor.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('SUPERVISOR_ALREADY_RUNNING')
    (run_root / 'direct-supervisor.pid').write_text(str(os.getpid()))
    env = {**os.environ, **settings(ROOT / 'shared/config/nonsecret.env')}
    env.update({
        'SGX_FEATURE_PORT': '8766', 'SGX_FEATURE_ENDPOINT': 'http://127.0.0.1:8766',
        'SGX_GIT_COMMIT': args.release, 'SGX_RELEASE_ID': args.release,
        'SGX_FEATURE_HOST': '127.0.0.1', 'SGX_CLASSIFICATION_BUILD_DIR': str(release / 'compiled'),
        'SGX_API_DATA_ROOT': str(ROOT / 'shared/api-v1'),
        'SGX_API_BUDGET_DATA_ROOT': str(ROOT / 'shared/api-budget'),
        'SGX_API_TOKEN_FILE': str(ROOT / 'shared/secrets/direct-api-token'),
        'CLASSIFICATION_REAL_CALL_AUTHORIZATION_PATH': str(ROOT / 'shared/api-budget/authorization.json'),
        'SGX_PROVIDER_AUDIT_DIR': str(ROOT / 'shared/api-v1/provider-responses'),
        'PYTHONPATH': str(release / 'feature-service/src'),
    })
    authorization = Path(env['CLASSIFICATION_REAL_CALL_AUTHORIZATION_PATH'])
    if not authorization.is_file():
        env.pop('CLASSIFICATION_REAL_CALL_AUTHORIZATION_PATH')
    key_file = ROOT / 'shared/secrets/qwen-api-key'
    if key_file.is_file():
        if key_file.stat().st_mode & 0o077:
            raise SystemExit('SECRET_PERMISSIONS_INVALID')
        env['SGX_D4_API_KEY'] = key_file.read_text().strip()
    else:
        env.pop('SGX_D4_API_KEY', None)
    python = env.get('SGX_FEATURE_PYTHON', str(RUNTIME / 'venvs/feature-service-all-py310-20261003-r2/bin/python'))
    node = str(ROOT / 'shared/runtimes/node-v22.22.1-linux-x64/bin/node')
    children: dict[str, subprocess.Popen] = {}
    log_handles = []
    restarts = {'feature': 0, 'api': 0}
    stop = False

    def stopping(_signal, _frame):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)

    def start(name: str, command: list[str]):
        timestamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        logfile = ROOT / 'shared/logs' / f'direct-{name}-{args.release}-{timestamp}-{restarts[name]}.log'
        handle = logfile.open('ab')
        log_handles.append(handle)
        child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
                                 stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
        children[name] = child
        (run_root / f'direct-{name}.pid').write_text(str(child.pid))
        restarts[name] += 1
        record('child_started', component=name, pid=child.pid, starts=restarts[name])

    warm = None
    warm_handle = None
    next_warm = 0.0
    started = {}
    try:
        record('supervisor_started', release=args.release)
        while not stop:
            for name, command in [
                ('feature', [python, '-m', 'sgx_classification_feature_service']),
                ('api', [node, str(release / 'classification-api/runtime/main.mjs')]),
            ]:
                child = children.get(name)
                if child and child.poll() is not None:
                    record('child_exited', component=name, code=child.returncode)
                    children.pop(name)
                    if name == 'feature':
                        next_warm = 0
                if name not in children and time.monotonic() - started.get(name, 0) > 15:
                    start(name, command)
                    started[name] = time.monotonic()
            if warm and warm.poll() is not None:
                record('feature_warm_finished', code=warm.returncode)
                warm_handle.close()
                warm = None
                next_warm = time.monotonic() + 60
            if not warm and time.monotonic() >= next_warm and probe(8766, '/healthz'):
                ready = probe(8766, '/readyz')
                if not ready or ready.get('status') != 'ready':
                    fixture = ROOT / 'shared/config/direct-warm-fixtures.json'
                    if fixture.is_file():
                        paths = json.loads(fixture.read_text())
                        if set(paths) != {'image', 'faceImage', 'text', 'audio'}:
                            raise ValueError('WARM_FIXTURES_INVALID')
                        if any(not Path(v).is_file() or not Path(v).resolve().is_relative_to(ROOT) for v in paths.values()):
                            raise ValueError('WARM_FIXTURES_OUTSIDE_PERSISTENT_ROOT')
                        logfile = ROOT / 'shared/logs' / f'direct-warm-{time.time_ns()}.json'
                        warm_handle = logfile.open('ab')
                        warm = subprocess.Popen([python, str(release / 'classification-worker/tools/warm-feature-service.py'),
                            '--base-url', 'http://127.0.0.1:8766', '--image', paths['image'],
                            '--face-image', paths['faceImage'], '--text', paths['text'], '--audio', paths['audio']],
                            env=env, stdin=subprocess.DEVNULL, stdout=warm_handle, stderr=subprocess.STDOUT,
                            start_new_session=True)
                        record('feature_warm_started', pid=warm.pid)
                    else:
                        record('feature_warm_missing_fixtures')
                        next_warm = time.monotonic() + 60
            time.sleep(5)
    finally:
        if warm and warm.poll() is None:
            os.killpg(warm.pid, signal.SIGTERM)
        for name, child in children.items():
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in children.values():
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        for handle in log_handles:
            handle.close()
        record('supervisor_stopped')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
