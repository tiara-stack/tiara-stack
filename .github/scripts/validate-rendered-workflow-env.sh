#!/usr/bin/env bash

set -euo pipefail

rendered_chart=$(cat)

for deployment in sheet-workflows sheet-workflows-runner sheet-workflows-browser-runner; do
  if ! awk -v target="${deployment}" '
    function evaluate_document() {
      if (has_target && has_service_id && has_oauth_client_id) {
        found = 1
      }
    }

    function reset_document() {
      in_deployment = 0
      has_target = 0
      has_service_id = 0
      has_oauth_client_id = 0
    }

    /^---$/ {
      evaluate_document()
      reset_document()
      next
    }

    /^kind: Deployment$/ {
      in_deployment = 1
      next
    }

    in_deployment && $0 == "  name: " target {
      has_target = 1
      next
    }

    in_deployment && has_target && /name: SHEET_AUTO_CHECKIN_SERVICE_ID$/ {
      has_service_id = 1
      next
    }

    in_deployment && has_target && /name: SHEET_AUTO_CHECKIN_OAUTH_CLIENT_ID$/ {
      has_oauth_client_id = 1
      next
    }

    END {
      evaluate_document()
      exit found ? 0 : 1
    }
  ' <<<"${rendered_chart}"; then
    echo "${deployment} must render both auto-check-in identity environment variables" >&2
    exit 1
  fi
done

for deployment in sheet-workflows sheet-workflows-runner sheet-workflows-browser-runner; do
  if ! awk -v target="${deployment}" '
    function evaluate_document() {
      if (has_target && has_shared_secret && !has_role_specific_secret) {
        found = 1
      }
    }

    function reset_document() {
      in_deployment = 0
      in_secret_key_ref = 0
      has_target = 0
      has_shared_secret = 0
      has_role_specific_secret = 0
    }

    /^---$/ {
      evaluate_document()
      reset_document()
      next
    }

    /^kind: Deployment$/ {
      in_deployment = 1
      next
    }

    in_deployment && $0 == "  name: " target {
      has_target = 1
      next
    }

    in_deployment && has_target && /secretKeyRef:$/ {
      in_secret_key_ref = 1
      next
    }

    in_deployment && has_target && in_secret_key_ref && /^[[:space:]]+name: / {
      secret_name = $0
      sub(/^[[:space:]]+name: /, "", secret_name)
      if (secret_name == "sheet-workflows-secret") {
        has_shared_secret = 1
      }
      if (secret_name == "sheet-workflows-runner-secret" || secret_name == "sheet-workflows-browser-runner-secret") {
        has_role_specific_secret = 1
      }
      in_secret_key_ref = 0
      next
    }

    END {
      evaluate_document()
      exit found ? 0 : 1
    }
  ' <<<"${rendered_chart}"; then
    echo "${deployment} must use the provisioned shared workflow Secret" >&2
    exit 1
  fi
done

echo "Rendered workflow deployments include auto-check-in identities and shared workflow Secret configuration"
