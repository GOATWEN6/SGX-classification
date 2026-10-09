#!/usr/bin/env python3
"""Transfer the existing macOS SGX key to isolated cloud secret storage over SSH.

Never prints the key, passes it in argv, or includes it in an ordinary env file.
This script only configures the credential; it makes no model request.
"""
from __future__ import annotations

import getpass
import argparse
import subprocess


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True, help='已核验 SSH user@host；不包含密码')
    parser.add_argument('--identity', required=True, help='已有专用 SSH 私钥路径；不读取内容')
    parser.add_argument('--port', type=int, default=30022)
    args = parser.parse_args()
    if args.destination.startswith('-') or not 1 <= args.port <= 65535:
        raise SystemExit('SSH_TARGET_INVALID')
    key = subprocess.run([
        'security', 'find-generic-password', '-a', getpass.getuser(),
        '-s', 'com.freewizardwu.ai-frame.sgx-d4-api-key', '-w',
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if key.returncode or not key.stdout.strip():
        print('SGX_D4_KEYCHAIN_MISSING')
        return 2
    secret = key.stdout.strip()
    if b'\n' in secret or b'\r' in secret or b'\0' in secret:
        print('SGX_D4_KEYCHAIN_VALUE_INVALID')
        return 2
    remote = """python3 -c 'import sys,os; from pathlib import Path
root=Path("/gemini/code/sgx-classification/shared/secrets")
root.mkdir(mode=0o700,parents=True,exist_ok=True)
key=sys.stdin.buffer.read().strip()
assert key and b"\\n" not in key and b"\\r" not in key and b"\\0" not in key
target=root/"qwen-api-key"
if target.exists():
    assert not target.is_symlink()
    backup=root/("qwen-api-key.before-"+str(__import__("time").time_ns()))
    backup.write_bytes(target.read_bytes());os.chmod(backup,0o600)
temporary=root/(".qwen-api-key.tmp-"+str(os.getpid()))
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"wb") as stream:stream.write(key+b"\\n")
os.replace(temporary,target);os.chmod(target,0o600)
print("SGX_CLOUD_QWEN_SECRET_READY")'
"""
    command = [
        'ssh', '-i', args.identity,
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa',
        '-o', 'ConnectTimeout=15', '-p', str(args.port), args.destination, remote,
    ]
    result = subprocess.run(command, input=secret, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=45)
    if result.returncode:
        # SSH/server diagnostics might contain secret-related details. Use a stable code.
        print('SGX_CLOUD_QWEN_SECRET_TRANSFER_FAILED')
        return 3
    if result.stdout.strip() != b'SGX_CLOUD_QWEN_SECRET_READY':
        print('SGX_CLOUD_QWEN_SECRET_TRANSFER_UNCONFIRMED')
        return 3
    print('SGX_CLOUD_QWEN_SECRET_READY')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
