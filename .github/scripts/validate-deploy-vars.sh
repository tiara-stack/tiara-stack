#!/usr/bin/env bash

validate_dns_label() {
  local name="$1"
  local value="$2"

  if [[ ${#value} -gt 63 ]]; then
    echo "${name} must be at most 63 characters" >&2
    return 1
  fi

  if [[ ! "${value}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
    echo "${name} must be a valid DNS label (lowercase alphanumeric and hyphens, must start and end with an alphanumeric)" >&2
    return 1
  fi

  return 0
}

validate_cluster_name() {
  local name="$1"
  local value="$2"

  # DigitalOcean cluster names are stricter than validate_dns_label:
  # CLUSTER_NAME must start with a lowercase letter, not a number.
  if [[ ${#value} -lt 1 || ${#value} -gt 63 ]]; then
    echo "${name} must be between 1 and 63 characters" >&2
    return 1
  fi

  if [[ ! "${value}" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]]; then
    echo "${name} must start with a lowercase letter, contain only lowercase letters, numbers, and hyphens, and end with a letter or number" >&2
    return 1
  fi

  return 0
}

validate_rfc1123_subdomain() {
  local name="$1"
  local value="$2"

  if [[ -z "${value}" ]]; then
    echo "${name} must not be empty" >&2
    return 1
  fi

  if [[ "${value}" == .* || "${value}" == *. || "${value}" == *..* ]]; then
    echo "${name} must not contain leading, trailing, or consecutive dots" >&2
    return 1
  fi

  if [[ ${#value} -gt 253 ]]; then
    echo "${name} must be at most 253 characters" >&2
    return 1
  fi

  local label
  local labels
  IFS='.' read -ra labels <<< "${value}"
  for label in "${labels[@]}"; do
    if [[ -z "${label}" ]]; then
      echo "${name} contains empty label (check for leading/trailing/consecutive dots)" >&2
      return 1
    fi
    if [[ ${#label} -gt 63 || ! "${label}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
      echo "${name} each label must be at most 63 characters and match RFC 1123" >&2
      return 1
    fi
  done

  return 0
}

validate_url_without_comma() {
  local name="$1"
  local value="$2"

  if [[ "${value}" == *","* || ! "${value}" =~ ^https?://[^[:space:],]+$ ]]; then
    echo "${name} must be an http(s) URL without commas" >&2
    return 1
  fi

  return 0
}

validate_deploy_vars() {
  local mode="${1:-required}"
  local missing=false
  local name

  for name in REGISTRY_NAME K8S_NAMESPACE INFISICAL_PROJECT_ID INFISICAL_ADDRESS; do
    if [[ -z "${!name}" ]]; then
      if [[ "${mode}" == "optional" ]]; then
        echo "Skipping deployment render because ${name} is not set" >&2
        missing=true
      else
        echo "${name} variable is required" >&2
        return 1
      fi
    fi
  done

  if [[ "${missing}" == "true" ]]; then
    return 2
  fi

  validate_dns_label REGISTRY_NAME "${REGISTRY_NAME}" || return 1
  validate_dns_label K8S_NAMESPACE "${K8S_NAMESPACE}" || return 1
  validate_url_without_comma INFISICAL_ADDRESS "${INFISICAL_ADDRESS}" || return 1
  if [[ -n "${ZERO_CACHE_EXISTING_VOLUME_NAME}" ]]; then
    validate_rfc1123_subdomain ZERO_CACHE_EXISTING_VOLUME_NAME "${ZERO_CACHE_EXISTING_VOLUME_NAME}" || return 1
  fi
  if [[ -n "${MEILISEARCH_EXISTING_VOLUME_NAME}" ]]; then
    validate_rfc1123_subdomain MEILISEARCH_EXISTING_VOLUME_NAME "${MEILISEARCH_EXISTING_VOLUME_NAME}" || return 1
  fi
  return 0
}
