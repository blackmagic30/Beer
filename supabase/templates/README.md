# Pint Path Supabase Email Templates

These files are the source of truth for Supabase Auth transactional emails.
Copy the matching HTML into the Supabase Dashboard for the intended environment.
Staging is project `bbfibbadwjxzrcdncavy`; production is
`jxpubqlmqnnqwadmjgyk`. Changing a template does not configure its sender.

## Templates

| Supabase template | Subject | File |
| --- | --- | --- |
| Confirm signup | `Confirm your Pint Path account` | `supabase/templates/confirmation.html` |
| Magic Link / Security reauthentication | `Your Pint Path security link` | `supabase/templates/magic_link.html` |
| Reset password / Recovery | `Reset your Pint Path password` | `supabase/templates/recovery.html` |
| Password changed notification | `Your Pint Path password was changed` | `supabase/templates/password_changed_notification.html` |

## Dashboard Checklist

1. Open the intended Supabase project. Validate changes on staging first; do not
   change production as part of a staging setup.
2. Go to `Authentication` -> `Emails` / `Email Templates`.
3. Paste each HTML file into the matching template.
4. Set the matching subject from the table above.
5. Confirm `Site URL` matches that environment: `https://beer-staging.up.railway.app`
   for staging or `https://pintpath.au` for production.
6. Preserve the existing redirect allowlist. Staging requires
   `https://beer-staging.up.railway.app/auth/callback`. Production includes:
   - `https://pintpath.au/auth/callback`
   - `https://pintpath.au/reset-password.html`
   - `https://pintpath.au/resend-confirmation.html`
   - `http://localhost:3000/auth/callback`
   - `http://localhost:3000/reset-password.html`
   - `http://localhost:3000/resend-confirmation.html`

## Required Supabase Variables

The templates intentionally use only common Supabase Auth variables:

- `{{ .ConfirmationURL }}` for signup confirmation and password recovery links.
- `{{ .Email }}` for the account email shown inside transactional emails.
- `{{ .SiteURL }}` for the footer and account-security links.

Do not add private app data, billing details, user location, submission photos,
or discount codes to Auth email templates.

Each production template also includes the verified Pint Path operator identity,
ABN, service address, direct support email, and links to the live Terms and
Privacy pages. Keep those footer details consistent across these templates.

## User Flow

- Signup starts from `/account.html`.
- Confirmation emails return through `/auth/callback`.
- Missing confirmation emails can be resent from `/resend-confirmation.html`.
- Password reset starts at `/reset-password.html`.
- Supabase recovery emails return through `/auth/callback`, then back to
  `/reset-password.html?mode=update`.
- Password-changed notifications point users back to `/reset-password.html` if
  they did not make the change.

## Sender and security-link setup

Use custom SMTP in Supabase Authentication → Email → SMTP Settings to set the
visible sender to `Pint Path` and an address on the verified `pintpath.au` sending
domain. A template alone cannot replace the default `Supabase Auth` sender.
For the existing Resend integration, use `smtp.resend.com`, port `465`, username
`resend`, and a valid sending key as the SMTP password. Never commit that key.
Do not enable SMTP with masked placeholder values. Confirm receipt in a controlled
inbox after configuring it.

The magic-link template supports the existing bound account-security ceremony.
Pint Path's challenge lasts 10 minutes even if the provider's OTP setting is longer.
The email must return to the original tab, particularly in Safari Private Browsing.
Keep `{{ .ConfirmationURL }}` unchanged: do not replace it with a bare callback URL,
change consent requirements, or remove browser/session binding to work around a
missing or expired security check.
