#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

render_development_source() {
  local staged_root=$1
  local active_root=$2
  local args=(
    --values charts/tiara-stack/values.yaml
    --set-string global.appImage.registry=ci-validation
    --set-string global.appImage.tag=template-validation
    --set services.sheetWorkflowsRunner.developmentSource.enabled=true
  )

  if [[ -n $staged_root ]]; then
    args+=(--set-string "services.sheetWorkflowsRunner.env.TIA_RUNNER_STAGED_SOURCE_ROOT=$staged_root")
  fi
  if [[ -n $active_root ]]; then
    args+=(--set-string "services.sheetWorkflowsRunner.env.TIA_RUNNER_ACTIVE_SOURCE_ROOT=$active_root")
  fi

  helm template tiara-stack charts/tiara-stack "${args[@]}"
}

render_scheduling_profile() {
  local profile=$1
  helm template tiara-stack charts/tiara-stack \
    --values charts/tiara-stack/values.yaml \
    --values "charts/tiara-stack/${profile}" \
    --set-string global.appImage.registry=ci-validation \
    --set-string global.appImage.tag=template-validation \
    --set-string infisical.projectId=ci-template-project \
    --set-string infisical.connection.address=https://infisical.example.invalid \
    --set-string 'global.imagePullSecrets[0].name=ci-registry'
}

assert_workloads_use_tiara_node_pool() {
  local profile=$1
  local rendered
  rendered=$(render_scheduling_profile "$profile")

  awk '
    function check_workload(    kind, has_node_pool, has_stale_selector, inside_node_selector, node_selector_indent, expected_indent, line_indent, line, doc_line, trimmed_doc_line) {
      if (document_line_count == 0) {
        return
      }

      kind = ""
      has_node_pool = 0
      has_stale_selector = 0
      inside_node_selector = 0
      node_selector_indent = -1
      expected_indent = -1
      for (line = 1; line <= document_line_count; line++) {
        doc_line = document_lines[line]
        if (doc_line ~ /^kind: /) {
          kind = doc_line
          sub(/^kind: /, "", kind)
        }
        if (kind == "Pod") {
          expected_indent = 2
        } else if (kind == "CronJob") {
          expected_indent = 10
        } else if (kind == "Deployment" || kind == "StatefulSet" || kind == "Job") {
          expected_indent = 6
        }
        # Rendered PodSpec.nodeSelector is at 2 spaces for Pod, 6 for standard workloads, and 10 for CronJob.
        if (doc_line ~ /^[[:space:]]*nodeSelector:[[:space:]]*$/) {
          line_indent = match(doc_line, /[^[:space:]]/) - 1
          if (line_indent == expected_indent) {
            node_selector_indent = line_indent
            inside_node_selector = 1
          }
          continue
        }
        if (inside_node_selector) {
          if (doc_line ~ /^[[:space:]]*$/) {
            continue
          }
          line_indent = match(doc_line, /[^[:space:]]/) - 1
          if (line_indent <= node_selector_indent) {
            inside_node_selector = 0
          } else {
            trimmed_doc_line = doc_line
            sub(/^[[:space:]]+/, "", trimmed_doc_line)
            sub(/[[:space:]]+$/, "", trimmed_doc_line)
            if (trimmed_doc_line == "doks.digitalocean.com/node-pool: pool-tiara-stack") {
              has_node_pool = 1
            }
            if (trimmed_doc_line == "deployment: tiara-stack" || trimmed_doc_line == "kubernetes.io/hostname: pool-tiara-stack-37ndzl") {
              has_stale_selector = 1
            }
          }
        }
      }
      if (kind == "Pod" || kind == "Deployment" || kind == "StatefulSet" || kind == "Job" || kind == "CronJob") {
        workload_count++
        if (has_node_pool && !has_stale_selector) {
          matched_count++
        }
      }
    }
    {
      if ($0 ~ /^---[[:space:]]*$/) {
        check_workload()
        document_line_count = 0
        next
      }
      document_lines[++document_line_count] = $0
    }
    END {
      check_workload()
      if (workload_count == 0 || workload_count != matched_count) {
        printf "Expected every rendered workload to select pool-tiara-stack without stale selectors, got %d of %d\n", matched_count, workload_count > "/dev/stderr"
        exit 1
      }
    }
  ' <<<"$rendered"
}

# Both deployment profiles must schedule every workload on the dedicated DOKS pool.
assert_workloads_use_tiara_node_pool values-production.yaml
assert_workloads_use_tiara_node_pool values-development.yaml

assert_helm_failure() {
  local expected_anchor=$1
  local expected_detail=$2
  local staged_root=$3
  local active_root=$4
  local output
  local normalized_output

  if output=$(render_development_source "$staged_root" "$active_root" 2>&1); then
    echo "Expected Helm render to fail for staged=${staged_root}, active=${active_root}" >&2
    exit 1
  fi
  normalized_output=${output,,}
  if [[ $normalized_output != *"${expected_anchor,,}"* ]] || {
    [[ -n $expected_detail ]] && [[ $normalized_output != *"${expected_detail,,}"* ]]
  }; then
    echo "Helm render failed for an unexpected reason (staged=${staged_root}, active=${active_root})." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

assert_environment_validation_failure() {
  local expected_message=$1
  local staged_root=$2
  local active_root=$3
  local rendered
  local output

  # Render the supplied roots swapped, after proving Helm accepts those paths.
  rendered=$(render_development_source "$active_root" "$staged_root")
  if output=$(bash .github/scripts/validate-development-source-env.sh \
    "$staged_root" "$active_root" <<<"$rendered" 2>&1); then
    echo "The development-source environment check accepted swapped path values" >&2
    exit 1
  fi
  if [[ $output != *"$expected_message"* ]]; then
    echo "Rendered environment failed validation for an unexpected reason:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

staged_root_path_key="TIA_RUNNER_STAGED_SOURCE_ROOT"
active_root_path_key="TIA_RUNNER_ACTIVE_SOURCE_ROOT"
overlapping_roots_error="source roots must be distinct, non-overlapping directories"
swapped_roots_error="Expected TIA_RUNNER_STAGED_SOURCE_ROOT to map to /workspace/custom/staged"

# Confirm defaults render with only the chart values and image settings.
render_development_source "" "" \
  | bash .github/scripts/validate-development-source-env.sh /workspace/staged /workspace/active

# Matching variables in unrelated Deployments must not affect runner validation.
rendered_defaults=$(render_development_source "" "")
{
  printf '%s\n' "$rendered_defaults"
  cat <<'YAML'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: unrelated-decoy
spec:
  template:
    spec:
      containers:
        - name: decoy
          env:
            - name: TIA_RUNNER_STAGED_SOURCE_ROOT
              value: /workspace/staged
            - name: TIA_RUNNER_ACTIVE_SOURCE_ROOT
              value: /workspace/active
YAML
} | bash .github/scripts/validate-development-source-env.sh /workspace/staged /workspace/active

# Custom and mixed overrides are accepted, while swapped rendered values are rejected.
render_development_source /workspace/custom/staged /workspace/custom/active \
  | bash .github/scripts/validate-development-source-env.sh /workspace/custom/staged /workspace/custom/active
assert_environment_validation_failure \
  "$swapped_roots_error" /workspace/custom/staged /workspace/custom/active
render_development_source "" /workspace/custom/active \
  | bash .github/scripts/validate-development-source-env.sh /workspace/staged /workspace/custom/active
render_development_source /workspace/custom/staged "" \
  | bash .github/scripts/validate-development-source-env.sh /workspace/custom/staged /workspace/active

# Every invalid-root case must fail for the chart's intended validation reason.
assert_helm_failure "$staged_root_path_key" pattern /custom/staged /workspace/custom/active
assert_helm_failure "$staged_root_path_key" not /workspace/../outside /workspace/custom/active
assert_helm_failure "$active_root_path_key" pattern /workspace/custom/staged /custom/active
assert_helm_failure "$active_root_path_key" not /workspace/custom/staged /workspace/../outside
assert_helm_failure "$overlapping_roots_error" "" /workspace/custom/shared /workspace/custom/shared
assert_helm_failure "$overlapping_roots_error" "" /workspace/custom /workspace/custom/active
assert_helm_failure "$overlapping_roots_error" "" /workspace/custom/active /workspace/custom
