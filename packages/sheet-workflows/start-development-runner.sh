#!/bin/sh
set -eu

case $# in
  0)
    optional_ca_file=/usr/local/share/ca-certificates/tiarastack/tiarastack.crt
    service_account_ca_file=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    extra_ca_file=/tmp/node-extra-ca.crt
    ;;
  3)
    optional_ca_file=$1
    service_account_ca_file=$2
    extra_ca_file=$3
    ;;
  *)
    echo "Usage: $0 [optional-ca-file service-account-ca-file extra-ca-file]" >&2
    exit 2
    ;;
  esac

if [ ! -f "$service_account_ca_file" ] || [ ! -r "$service_account_ca_file" ]; then
  echo "Service-account CA file is missing or unreadable: $service_account_ca_file" >&2
  exit 1
fi

{
  if [ -f "$optional_ca_file" ] && [ -r "$optional_ca_file" ]; then
    cat "$optional_ca_file"
    printf '\n'
  fi
  cat "$service_account_ca_file"
} >"$extra_ca_file"

NODE_EXTRA_CA_CERTS=$extra_ca_file exec node --use-openssl-ca --enable-source-maps ./dist/index.mjs
