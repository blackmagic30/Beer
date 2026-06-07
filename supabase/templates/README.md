# Pint Path Supabase Email Templates

These files are the source of truth for Supabase Auth transactional emails.
Copy the matching HTML into the Supabase Dashboard when changing production
templates.

## Templates

| Supabase template | Subject | File |
| --- | --- | --- |
| Confirm signup | `Confirm your Pint Path account` | `supabase/templates/confirmation.html` |
| Reset password / Recovery | `Reset your Pint Path password` | `supabase/templates/recovery.html` |
| Password changed notification | `Your Pint Path password was changed` | `supabase/templates/password_changed_notification.html` |

## Dashboard Checklist

1. Open Supabase Dashboard for project `jxpubqlmqnnqwadmjgyk`.
2. Go to `Authentication` -> `Emails` / `Email Templates`.
3. Paste each HTML file into the matching template.
4. Set the matching subject from the table above.
5. Confirm `Site URL` is `https://pintpath.au`.
6. Confirm redirect URLs include:
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

## User Flow

- Signup starts from `/account.html`.
- Confirmation emails return through `/auth/callback`.
- Missing confirmation emails can be resent from `/resend-confirmation.html`.
- Password reset starts at `/reset-password.html`.
- Supabase recovery emails return through `/auth/callback`, then back to
  `/reset-password.html?mode=update`.
- Password-changed notifications point users back to `/reset-password.html` if
  they did not make the change.
