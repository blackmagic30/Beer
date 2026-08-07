#!/bin/bash

set -euo pipefail

archive_path="${1:-}"
expected_api_base_url="${EXPECTED_PINT_PATH_API_BASE_URL:-}"
expected_supabase_anon_key="${EXPECTED_SUPABASE_ANON_KEY:-}"
approved_supabase_url="https://auth.pintpath.au"

fail() {
  printf 'iOS archive inspection error: %s\n' "$1" >&2
  exit 1
}

[[ -n "$archive_path" ]] || fail "an .xcarchive path is required."
[[ -n "$expected_api_base_url" ]] || fail "EXPECTED_PINT_PATH_API_BASE_URL is required."
[[ -n "$expected_supabase_anon_key" ]] || fail "EXPECTED_SUPABASE_ANON_KEY is required."

app_plist="${archive_path}/Products/Applications/BeerMap.app/Info.plist"
[[ -f "$app_plist" ]] || fail "the archived BeerMap.app Info.plist is missing."
/usr/bin/plutil -lint "$app_plist" >/dev/null

read_plist_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$app_plist"
}

archived_api_base_url="$(read_plist_value PINT_PATH_API_BASE_URL)"
archived_supabase_url="$(read_plist_value SUPABASE_URL)"
archived_supabase_anon_key="$(read_plist_value SUPABASE_ANON_KEY)"

[[ "$archived_api_base_url" == "$expected_api_base_url" ]] \
  || fail "PINT_PATH_API_BASE_URL does not match the expected Release value."
[[ "$archived_supabase_url" == "$approved_supabase_url" ]] \
  || fail "SUPABASE_URL does not match the independently approved production origin."
[[ "$archived_supabase_anon_key" == "$expected_supabase_anon_key" ]] \
  || fail "SUPABASE_ANON_KEY does not match the expected Release value."
[[ "$archived_api_base_url$archived_supabase_url$archived_supabase_anon_key" != *'$('* ]] \
  || fail "the archive contains an unexpanded build-setting placeholder."

printf 'Archived Pint Path API and public Supabase configuration match the expected Release inputs (key value hidden).\n'
