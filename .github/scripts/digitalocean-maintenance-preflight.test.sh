#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/digitalocean-maintenance-preflight.sh"

export DATABASE_CLUSTER_ID="test-cluster-id"
export TEST_DOCTL_SHOULD_FAIL=false
readonly EXPECTED_DATABASE_CLUSTER_ID="test-cluster-id"
TEST_DOCTL_OUTPUT='{"day":"tuesday","hour":"22:00","pending":false}'

doctl() {
  if [[ "$#" -ne 6 || "$1" != "databases" || "$2" != "maintenance-window" || "$3" != "get" || "$4" != "${EXPECTED_DATABASE_CLUSTER_ID}" || "$5" != "--output" || "$6" != "json" ]]; then
    return 1
  fi

  if [[ "${TEST_DOCTL_SHOULD_FAIL}" == "true" ]]; then
    return 1
  fi

  printf '%s\n' "${TEST_DOCTL_OUTPUT}"
}

run_preflight() {
  local now="$1"
  local output status

  export DIGITALOCEAN_MAINTENANCE_PREFLIGHT_NOW="${now}"
  set +e
  output="$(main 2>&1)"
  status=$?
  set -e

  printf '%s\n' "${status}" "${output}"
}

expect_success() {
  local name="$1"
  local now="$2"
  local result status output

  result="$(run_preflight "${now}")"
  status="${result%%$'\n'*}"
  output="${result#*$'\n'}"
  if [[ "${status}" != "0" || "${output}" != *"preflight passed"* ]]; then
    echo "FAIL: ${name}" >&2
    echo "${output}" >&2
    exit 1
  fi
}

expect_failure() {
  local name="$1"
  local now="$2"
  local expected="$3"
  local result status output

  result="$(run_preflight "${now}")"
  status="${result%%$'\n'*}"
  output="${result#*$'\n'}"
  if [[ "${status}" == "0" || "${output}" != *"${expected}"* ]]; then
    echo "FAIL: ${name}" >&2
    echo "${output}" >&2
    exit 1
  fi
}

expect_success "allows the second before the protected interval" "2026-09-15T21:29:59Z"
expect_failure "blocks exactly 30 minutes before the provider window" "2026-09-15T21:30:00Z" "Deployment protection interval:"
expect_failure "blocks exactly at the protected interval end" "2026-09-16T03:00:00Z" "Retry after:"
expect_success "allows the second after the protected interval" "2026-09-16T03:00:01Z"

TEST_DOCTL_OUTPUT='{"day":"sunday","hour":"23:00:30","pending":false}'
expect_success "allows the second before a configured-second protection interval" "2026-09-20T22:30:29Z"
expect_failure "blocks across midnight and the week boundary" "2026-09-21T03:59:59Z" "Deployment protection interval:"
expect_failure "blocks at the end of a configured-second protection interval" "2026-09-21T04:00:30Z" "Retry after:"
expect_success "allows after a Sunday window crosses into Monday" "2026-09-21T04:00:31Z"

TEST_DOCTL_SHOULD_FAIL=true
expect_failure "fails closed when the provider read fails" "2026-09-16T12:00:00Z" "API read failed"
TEST_DOCTL_SHOULD_FAIL=false

TEST_DOCTL_OUTPUT='not-json'
expect_failure "fails closed for malformed JSON" "2026-09-16T12:00:00Z" "malformed maintenance-window JSON"

TEST_DOCTL_OUTPUT='{"day":"funday","hour":"22:00"}'
expect_failure "fails closed for an invalid weekday" "2026-09-16T12:00:00Z" "invalid maintenance weekday"

TEST_DOCTL_OUTPUT='{"day":"tuesday","hour":"24:00"}'
expect_failure "fails closed for an invalid time" "2026-09-16T12:00:00Z" "invalid maintenance time"

original_path="${PATH}"
PATH=""
expect_failure "fails closed when the JSON parser is unavailable" "2026-09-16T12:00:00Z" "JSON parser is unavailable"
PATH="${original_path}"

TEST_DOCTL_OUTPUT='{"day":"tuesday","hour":22}'
expect_failure "fails closed for a valid JSON response with the wrong shape" "2026-09-16T12:00:00Z" "malformed maintenance-window JSON"

TEST_DOCTL_OUTPUT='{"day":"tuesday","hour":"22:00"}'
expect_failure "fails closed when the injected UTC time is invalid" "not-a-time" "current UTC time could not be determined"

unset -f doctl
original_path="${PATH}"
PATH=""
expect_failure "fails closed when the DigitalOcean CLI is unavailable" "2026-09-16T12:00:00Z" "CLI is unavailable"
PATH="${original_path}"

unset DATABASE_CLUSTER_ID
expect_failure "fails closed when cluster configuration is missing" "2026-09-16T12:00:00Z" "DATABASE_CLUSTER_ID repository variable is not configured"

echo "DigitalOcean maintenance preflight tests passed"
