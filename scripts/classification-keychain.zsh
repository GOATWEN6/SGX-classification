#!/bin/zsh
set -eu

service='com.freewizardwu.ai-frame.sgx-d4-api-key'
account="${USER:-$(id -un)}"
repo="${0:A:h:h}"
command="${1:-}"

has_key() {
  security find-generic-password -a "$account" -s "$service" >/dev/null 2>&1
}

setup_key() {
  if has_key; then
    print 'SGX_D4_KEYCHAIN_READY'
    return
  fi
  local secret="${SGX_D4_API_KEY:-}"
  if [[ -z "$secret" ]]; then
    read -rs "secret?首次安全保存：请输入 SGX_D4_API_KEY（以后不再询问，输入不会回显）："
    print
  fi
  if [[ -z "$secret" ]]; then
    print -u2 'SGX_D4_API_KEY_MISSING'
    return 2
  fi
  security add-generic-password -U -a "$account" -s "$service" -w "$secret" >/dev/null
  unset secret
  print 'SGX_D4_KEYCHAIN_READY'
}

case "$command" in
  setup)
    setup_key
    ;;
  status)
    if has_key; then print 'SGX_D4_KEYCHAIN_READY'; else print 'SGX_D4_KEYCHAIN_MISSING'; exit 2; fi
    ;;
  eval)
    shift
    setup_key >/dev/null
    SGX_D4_API_KEY="$(security find-generic-password -a "$account" -s "$service" -w)"
    export SGX_D4_API_KEY
    cd "$repo"
    npm run classification:eval -- "$@"
    status=$?
    unset SGX_D4_API_KEY
    exit $status
    ;;
  *)
    print -u2 '用法：scripts/classification-keychain.zsh setup|status|eval [classification:eval 参数]'
    exit 2
    ;;
esac
