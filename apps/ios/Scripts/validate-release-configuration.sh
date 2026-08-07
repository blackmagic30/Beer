#!/bin/bash

set -euo pipefail

if [[ "${CONFIGURATION:-}" != "Release" ]]; then
  exit 0
fi

fail() {
  printf 'error: Pint Path Release configuration is invalid: %s\n' "$1" >&2
  printf 'error: Copy apps/ios/Config.example.xcconfig to apps/ios/Config.xcconfig and supply public production values.\n' >&2
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

validate_legacy_anon_jwt() {
  local token="$1"
  local header
  local payload
  local signature
  local extra
  local padded_payload
  local decoded_payload
  local role

  IFS='.' read -r header payload signature extra <<< "$token"
  [[ -n "$header" && -n "$payload" && -n "$signature" && -z "${extra:-}" ]] \
    || fail "SUPABASE_ANON_KEY is not a valid publishable key or legacy anon JWT."

  padded_payload="$payload"
  case $((${#padded_payload} % 4)) in
    0) ;;
    2) padded_payload+="==" ;;
    3) padded_payload+="=" ;;
    *) fail "SUPABASE_ANON_KEY contains a malformed JWT payload." ;;
  esac
  decoded_payload="$(
    printf '%s' "$padded_payload" \
      | /usr/bin/tr '_-' '/+' \
      | /usr/bin/openssl base64 -d -A 2>/dev/null
  )" || fail "SUPABASE_ANON_KEY contains an unreadable JWT payload."
  role="$(
    printf '%s' "$decoded_payload" \
      | /usr/bin/plutil -extract role raw -o - -- - 2>/dev/null
  )" || fail "SUPABASE_ANON_KEY JWT does not declare an anon role."
  [[ "$role" == "anon" ]] \
    || fail "SUPABASE_ANON_KEY must be a public anon key, never a service-role key."
}

api_base_url="${PINT_PATH_API_BASE_URL:-}"
supabase_url="${SUPABASE_URL:-}"
supabase_anon_key="${SUPABASE_ANON_KEY:-}"
approved_supabase_url="https://auth.pintpath.au"

reject_missing_or_placeholder "PINT_PATH_API_BASE_URL" "$api_base_url"
reject_missing_or_placeholder "SUPABASE_URL" "$supabase_url"
reject_missing_or_placeholder "SUPABASE_ANON_KEY" "$supabase_anon_key"

[[ "$api_base_url" == "https://pintpath.au" ]] \
  || fail "PINT_PATH_API_BASE_URL must be exactly https://pintpath.au."
[[ "$supabase_url" == "$approved_supabase_url" ]] \
  || fail "SUPABASE_URL must exactly match the independently approved production origin https://auth.pintpath.au."

case "$supabase_anon_key" in
  sb_secret_*|*service_role*)
    fail "SUPABASE_ANON_KEY must be a public anon key, never a service-role key."
    ;;
  sb_publishable_*)
    [[ "$supabase_anon_key" =~ ^sb_publishable_[A-Za-z0-9_-]{20,}$ ]] \
      || fail "SUPABASE_ANON_KEY publishable-key format is invalid."
    ;;
  *)
    validate_legacy_anon_jwt "$supabase_anon_key"
    ;;
esac

printf 'Pint Path Release configuration validated (public Supabase key value hidden).\n'
