# POS integration contract

Pint Path currently provides a vendor-neutral Pro venue webhook and a manual counter fallback. A vendor-specific adapter is not complete until a real POS vendor and venue are selected.

## Endpoint

`POST /api/business/pos/discount-redemptions`

Use the per-venue token shown in the manager portal as `X-Pint-Path-POS-Token`. Rotating the token invalidates the previous value immediately. Never place it in browser code, receipts, logs, or a public repository.

Example payload:

```json
{
  "venueId": "venue-id",
  "code": "ABC123",
  "transactionReference": "pos-order-48391-line-2",
  "itemName": "Guinness pint",
  "quantity": 1,
  "estimatedSavingsCents": 200,
  "terminalId": "bar-1",
  "redeemedAt": "2026-07-13T10:30:00+10:00",
  "metadata": {
    "adapter": "vendor-name-and-version"
  }
}
```

`transactionReference` must be stable across retries. Pint Path treats it as the idempotency key so a timeout/retry cannot award twice. The adapter should retry network failures with the same payload and should not generate a new reference.

## Required adapter behaviour

- Send only after staff confirm the member and eligible item.
- Treat HTTP 2xx idempotent replay as success.
- Do not retry HTTP 4xx until staff correct the request.
- Back off and retry HTTP 5xx/network failures using the same transaction reference.
- Keep token access restricted to the venue and production environment.
- Do not send customer name, email, phone, payment-card data, or full receipt contents.
- Reconcile venue POS references against Pint Path activity and reversals at shift close.

Until a vendor adapter passes a real venue pilot, the manager portal QR/code flow is the supported fallback.
