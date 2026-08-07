#!/bin/bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_path="${1:-${script_dir}/../Config.xcconfig}"

fail() {
  printf 'iOS configuration error: %s\n' "$1" >&2
  exit 1
}

require_single_line() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || fail "${name} is required."
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || fail "${name} must be a single line."
}

xcconfig_url() {
  local value="$1"
  local scheme
  local remainder
  case "$value" in
    http://*|https://*)
      scheme="${value%%://*}"
      remainder="${value#*://}"
      printf '%s:/$()/%s' "$scheme" "$remainder"
      ;;
    *)
      fail "URL values must start with http:// or https://."
      ;;
  esac
}

api_base_url="${PINT_PATH_API_BASE_URL:-}"
supabase_url="${SUPABASE_URL:-}"
supabase_anon_key="${SUPABASE_ANON_KEY:-}"

require_single_line "PINT_PATH_API_BASE_URL" "$api_base_url"
require_single_line "SUPABASE_URL" "$supabase_url"
require_single_line "SUPABASE_ANON_KEY" "$supabase_anon_key"
[[ "$supabase_anon_key" != *'#'* && "$supabase_anon_key" != *'//'* ]] \
  || fail "SUPABASE_ANON_KEY contains characters that are unsafe in an xcconfig file."

output_dir="$(dirname "$output_path")"
mkdir -p "$output_dir"
temporary_path="${output_path}.tmp.$$"
trap 'rm -f "$temporary_path"' EXIT
umask 077
{
  printf '// Generated locally or by CI. Do not commit this file.\n'
  printf 'PINT_PATH_API_BASE_URL = %s\n' "$(xcconfig_url "$api_base_url")"
  printf 'SUPABASE_URL = %s\n' "$(xcconfig_url "$supabase_url")"
  printf 'SUPABASE_ANON_KEY = %s\n' "$supabase_anon_key"
} > "$temporary_path"
mv "$temporary_path" "$output_path"
trap - EXIT

printf 'Wrote private iOS build configuration to %s (values not printed).\n' "$output_path"
