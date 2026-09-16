#!/usr/bin/env bash

set -euo pipefail

readonly SECONDS_PER_MINUTE=60
readonly SECONDS_PER_HOUR=3600
readonly SECONDS_PER_DAY=86400
readonly SECONDS_PER_WEEK=604800
readonly PROTECTION_BEFORE_SECONDS=$((30 * SECONDS_PER_MINUTE))
readonly PROVIDER_WINDOW_SECONDS=$((4 * SECONDS_PER_HOUR))
readonly PROTECTION_AFTER_SECONDS=$((60 * SECONDS_PER_MINUTE))

fail_closed() {
  echo "::error::Production deployment blocked: DigitalOcean maintenance preflight failed closed — $1." >&2
  return 1
}

get_now_epoch() {
  if [[ -n "${DIGITALOCEAN_MAINTENANCE_PREFLIGHT_NOW:-}" ]]; then
    date -u -d "${DIGITALOCEAN_MAINTENANCE_PREFLIGHT_NOW}" +%s 2>/dev/null
    return
  fi

  date -u +%s
}

format_utc() {
  date -u -d "@$1" '+%Y-%m-%d %H:%M:%S UTC'
}

main() {
  if [[ -z "${DATABASE_CLUSTER_ID:-}" ]]; then
    fail_closed "DATABASE_CLUSTER_ID repository variable is not configured" || return 1
  fi

  if ! command -v doctl >/dev/null 2>&1; then
    fail_closed "the authenticated DigitalOcean CLI is unavailable" || return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    fail_closed "the JSON parser is unavailable" || return 1
  fi

  local window_json
  if ! window_json="$(doctl databases maintenance-window get "${DATABASE_CLUSTER_ID}" --output json 2>/dev/null)"; then
    fail_closed "DigitalOcean maintenance-window API read failed" || return 1
  fi

  local window_fields
  if ! window_fields="$(jq -er -s '
    if length != 1 or (.[0] | type) != "object" or (.[0].day | type) != "string" or (.[0].hour | type) != "string" then
      error("maintenance window must contain day and hour strings")
    else
      [.[0].day, .[0].hour] | @tsv
    end
  ' <<<"${window_json}" 2>/dev/null)"; then
    fail_closed "DigitalOcean returned malformed maintenance-window JSON" || return 1
  fi

  local maintenance_day maintenance_hour
  IFS=$'\t' read -r maintenance_day maintenance_hour <<<"${window_fields}"

  local maintenance_day_number
  case "${maintenance_day,,}" in
    monday) maintenance_day_number=1 ;;
    tuesday) maintenance_day_number=2 ;;
    wednesday) maintenance_day_number=3 ;;
    thursday) maintenance_day_number=4 ;;
    friday) maintenance_day_number=5 ;;
    saturday) maintenance_day_number=6 ;;
    sunday) maintenance_day_number=7 ;;
    *) fail_closed "DigitalOcean returned an invalid maintenance weekday" || return 1 ;;
  esac

  if [[ ! "${maintenance_hour}" =~ ^([01][0-9]|2[0-3]):([0-5][0-9])(:([0-5][0-9]))?$ ]]; then
    fail_closed "DigitalOcean returned an invalid maintenance time" || return 1
  fi

  local maintenance_hour_number=$((10#${BASH_REMATCH[1]}))
  local maintenance_minute_number=$((10#${BASH_REMATCH[2]}))
  local maintenance_second_number=0
  if [[ -n "${BASH_REMATCH[4]:-}" ]]; then
    maintenance_second_number=$((10#${BASH_REMATCH[4]}))
  fi

  local now_epoch
  if ! now_epoch="$(get_now_epoch)"; then
    fail_closed "the current UTC time could not be determined" || return 1
  fi

  local now_hour now_minute now_second now_weekday
  now_hour=$((10#$(date -u -d "@${now_epoch}" +%H)))
  now_minute=$((10#$(date -u -d "@${now_epoch}" +%M)))
  now_second=$((10#$(date -u -d "@${now_epoch}" +%S)))
  now_weekday=$((10#$(date -u -d "@${now_epoch}" +%u)))

  local current_day_start
  current_day_start=$((now_epoch - now_hour * SECONDS_PER_HOUR - now_minute * SECONDS_PER_MINUTE - now_second))

  local week_start maintenance_start protected_start protected_end
  week_start=$((current_day_start - (now_weekday - 1) * SECONDS_PER_DAY))

  local week_offset
  for week_offset in -1 0 1; do
    maintenance_start=$((week_start + (maintenance_day_number - 1) * SECONDS_PER_DAY + maintenance_hour_number * SECONDS_PER_HOUR + maintenance_minute_number * SECONDS_PER_MINUTE + maintenance_second_number + week_offset * SECONDS_PER_WEEK))
    protected_start=$((maintenance_start - PROTECTION_BEFORE_SECONDS))
    protected_end=$((maintenance_start + PROVIDER_WINDOW_SECONDS + PROTECTION_AFTER_SECONDS))

    if ((now_epoch >= protected_start && now_epoch <= protected_end)); then
      echo "::error::Production deployment blocked: DigitalOcean PostgreSQL maintenance-window protection is active." >&2
      echo "DigitalOcean maintenance window: $(format_utc "${maintenance_start}") through $(format_utc "$((maintenance_start + PROVIDER_WINDOW_SECONDS))")" >&2
      echo "Deployment protection interval: $(format_utc "${protected_start}") through $(format_utc "${protected_end}")" >&2
      echo "Current UTC time: $(format_utc "${now_epoch}")" >&2
      echo "Retry after: $(format_utc "$((protected_end + 1))")" >&2
      return 1
    fi
  done

  echo "DigitalOcean maintenance preflight passed for ${maintenance_day,,} at ${maintenance_hour} UTC; current time: $(format_utc "${now_epoch}")"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
