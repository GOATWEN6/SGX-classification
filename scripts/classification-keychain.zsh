#!/bin/zsh
set -eu

service='com.freewizardwu.ai-frame.sgx-d4-api-key'
external_access_service='com.freewizardwu.ai-frame.sgx-t1-external-access-token'
account="${USER:-$(id -un)}"
repo="${0:A:h:h}"
command="${1:-}"

has_key() {
  security find-generic-password -a "$account" -s "$service" >/dev/null 2>&1
}

has_external_access_token() {
  security find-generic-password -a "$account" -s "$external_access_service" >/dev/null 2>&1
}

setup_external_access_token() {
  if ! has_external_access_token; then
    local token="$(openssl rand -hex 32)"
    security add-generic-password -U -a "$account" -s "$external_access_service" -w "$token" >/dev/null
    unset token
  fi
  print 'SGX_T1_EXTERNAL_ACCESS_READY'
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
  external-setup)
    setup_external_access_token
    ;;
  external-copy)
    setup_external_access_token >/dev/null
    security find-generic-password -a "$account" -s "$external_access_service" -w | pbcopy
    print 'SGX_T1_EXTERNAL_ACCESS_TOKEN_COPIED'
    ;;
  external-gateway)
    shift
    setup_external_access_token >/dev/null
    CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN="$(security find-generic-password -a "$account" -s "$external_access_service" -w)"
    export CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN
    cd "$repo"
    node scripts/classification-t1-external-gateway.mjs "$@"
    exit_code=$?
    unset CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN
    exit $exit_code
    ;;
  eval)
    shift
    setup_key >/dev/null
    SGX_D4_API_KEY="$(security find-generic-password -a "$account" -s "$service" -w)"
    export SGX_D4_API_KEY
    cd "$repo"
    npm run classification:eval -- "$@"
    exit_code=$?
    unset SGX_D4_API_KEY
    exit $exit_code
    ;;
  lab-real)
    shift
    setup_key >/dev/null
    SGX_D4_API_KEY="$(security find-generic-password -a "$account" -s "$service" -w)"
    export SGX_D4_API_KEY
    if has_external_access_token; then
      CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN="$(security find-generic-password -a "$account" -s "$external_access_service" -w)"
      export CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN
      export CLASSIFICATION_T1_EXTERNAL_ACCESS_ENABLED=true
    fi
    cd "$repo"
    npm run classification:lab -- "$@"
    exit_code=$?
    unset SGX_D4_API_KEY
    unset CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN CLASSIFICATION_T1_EXTERNAL_ACCESS_ENABLED
    exit $exit_code
    ;;
  *)
    print -u2 '用法：scripts/classification-keychain.zsh setup|status|external-setup|external-copy|external-gateway|eval [classification:eval 参数]|lab-real [Next.js 参数]'
    exit 2
    ;;
esac
