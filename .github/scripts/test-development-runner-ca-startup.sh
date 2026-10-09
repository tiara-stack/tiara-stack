#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
runner_start="$repo_root/packages/sheet-workflows/start-development-runner.sh"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$temp_dir/bin"
cat >"$temp_dir/bin/node" <<'NODE'
#!/bin/sh
set -eu
cat "$NODE_EXTRA_CA_CERTS" > "$CAPTURED_CA"
printf '%s\n' "$@" > "$CAPTURED_ARGS"
: > "$NODE_STARTED"
NODE
chmod +x "$temp_dir/bin/node"

printf 'service-account-ca' >"$temp_dir/service-account.crt"
printf 'tiarastack-ca' >"$temp_dir/tiarastack.crt"

assert_runner_starts() {
  local case_name=$1
  local optional_ca_file=$2
  local expected_bundle=$3
  local extra_ca_file="$temp_dir/$case_name-extra-ca.crt"
  local captured_ca="$temp_dir/$case_name-captured-ca.crt"
  local captured_args="$temp_dir/$case_name-node-args.txt"
  local node_started="$temp_dir/$case_name-node-started"

  PATH="$temp_dir/bin:$PATH" \
    CAPTURED_CA="$captured_ca" \
    CAPTURED_ARGS="$captured_args" \
    NODE_STARTED="$node_started" \
    "$runner_start" "$optional_ca_file" "$temp_dir/service-account.crt" "$extra_ca_file"

  [[ -f $node_started ]]
  [[ "$(cat "$extra_ca_file")" == "$expected_bundle" ]]
  [[ "$(cat "$captured_ca")" == "$expected_bundle" ]]
  grep -Fq -- "--use-openssl-ca" "$captured_args"
  grep -Fq -- "./dist/index.mjs" "$captured_args"
}

assert_runner_starts service-account-only "$temp_dir/missing-tiara.crt" service-account-ca
assert_runner_starts both-cas "$temp_dir/tiarastack.crt" $'tiarastack-ca\nservice-account-ca'

missing_service_account_ca="$temp_dir/missing-service-account-ca.crt"
node_started="$temp_dir/missing-service-account-node-started"
if output=$(PATH="$temp_dir/bin:$PATH" \
  CAPTURED_CA="$temp_dir/missing-service-account-captured-ca.crt" \
  CAPTURED_ARGS="$temp_dir/missing-service-account-node-args.txt" \
  NODE_STARTED="$node_started" \
  "$runner_start" "$temp_dir/tiarastack.crt" "$missing_service_account_ca" \
  "$temp_dir/missing-service-account-extra-ca.crt" 2>&1); then
  echo "Expected startup to fail when the service-account CA is missing" >&2
  exit 1
fi
if [[ $output != *"$missing_service_account_ca"* ]]; then
  echo "Startup failure did not identify the missing service-account CA file:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi
[[ ! -e $node_started ]]
