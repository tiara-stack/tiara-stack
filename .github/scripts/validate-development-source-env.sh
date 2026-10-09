#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <expected-staged-root> <expected-active-root>" >&2
  exit 2
fi

expected_staged_root=$1
expected_active_root=$2
rendered=$(cat)

validate_env_pair() {
  local expected_name=$1
  local expected_value=$2
  local counts

  counts=$(awk -v target_name="$expected_name" -v expected_value="$expected_value" '
    /^---[[:space:]]*$/ {
      is_deployment = 0
      is_runner_deployment = 0
      is_target = 0
      next
    }
    /^[[:space:]]*kind:[[:space:]]*/ {
      kind = $0
      sub(/^[[:space:]]*kind:[[:space:]]*/, "", kind)
      is_deployment = kind == "Deployment"
      next
    }
    /^  name:[[:space:]]*/ && is_deployment {
      workload_name = $0
      sub(/^  name:[[:space:]]*/, "", workload_name)
      gsub(/"/, "", workload_name)
      is_runner_deployment = workload_name == "sheet-workflows-runner"
      next
    }
    /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ && is_runner_deployment {
      name = $0
      sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", name)
      gsub(/"/, "", name)
      is_target = name == target_name
      if (is_target) name_count++
      next
    }
    /^[[:space:]]*value:[[:space:]]*/ && is_runner_deployment && is_target {
      value = $0
      sub(/^[[:space:]]*value:[[:space:]]*/, "", value)
      gsub(/"/, "", value)
      if (value == expected_value) pair_count++
      is_target = 0
    }
    END { printf "%d %d\n", name_count, pair_count }
  ' <<<"$rendered")
  read -r name_count pair_count <<<"$counts"

  if [[ $name_count -ne 1 ]]; then
    echo "Expected exactly one ${expected_name} in development-source render; found ${name_count}" >&2
    exit 1
  fi
  if [[ $pair_count -ne 1 ]]; then
    echo "Expected ${expected_name} to map to ${expected_value} in development-source render" >&2
    exit 1
  fi
}

validate_env_pair TIA_RUNNER_STAGED_SOURCE_ROOT "$expected_staged_root"
validate_env_pair TIA_RUNNER_ACTIVE_SOURCE_ROOT "$expected_active_root"
