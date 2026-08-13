#!/bin/bash

set -euo pipefail
export LC_ALL=C

fail() {
  printf 'error: Pint Path build configuration is invalid: %s\n' "$1" >&2
  printf 'error: Leave SUPABASE_ANON_KEY blank for Debug, or use apps/ios/Config.xcconfig with an approved public key.\n' >&2
  exit 1
}

reject_missing_or_placeholder() {
  local name="$1"
  local value="$2"
  local normalized
  [[ -n "$value" ]] || fail "${name} is missing."
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *'$('* ]] \
    || fail "${name} is empty or unexpanded."
  normalized="$(printf '%s' "$value" | /usr/bin/tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    *placeholder*|*changeme*|*replace*|*example*|*your-project*|*your_project*|*'<'*|*'>'*|*'__'*)
      fail "${name} still contains a placeholder."
      ;;
  esac
}

api_base_url="${PINT_PATH_API_BASE_URL:-}"
supabase_url="${SUPABASE_URL:-}"
supabase_anon_key="${SUPABASE_ANON_KEY:-}"
approved_supabase_url="https://auth.pintpath.au"

if [[ -n "$supabase_anon_key" ]]; then
  case "$supabase_anon_key" in
    sb_secret_*)
      fail "SUPABASE_ANON_KEY must be a publishable key, never a secret or legacy service-role key."
      ;;
  esac
  [[ "$supabase_anon_key" =~ ^sb_publishable_[A-Za-z0-9_-]{20,220}$ ]] \
    || fail "SUPABASE_ANON_KEY must be an sb_publishable_ key with 20 to 220 URL-safe characters; legacy JWTs are not accepted."
fi

if [[ "${CONFIGURATION:-}" != "Release" ]]; then
  exit 0
fi

reject_missing_or_placeholder "PINT_PATH_API_BASE_URL" "$api_base_url"
reject_missing_or_placeholder "SUPABASE_URL" "$supabase_url"
[[ -n "$supabase_anon_key" ]] || fail "SUPABASE_ANON_KEY is missing."

[[ "$api_base_url" == "https://pintpath.au" ]] \
  || fail "PINT_PATH_API_BASE_URL must be exactly https://pintpath.au."
[[ "$supabase_url" == "$approved_supabase_url" ]] \
  || fail "SUPABASE_URL must exactly match the independently approved production origin https://auth.pintpath.au."

printf 'Pint Path Release configuration validated (public Supabase key value hidden).\n'
