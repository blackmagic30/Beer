# External launch sign-offs

The repository can enforce code, schema, security, and synthetic workflow gates. It cannot honestly self-approve these external items:

- Three real venue shifts using manager and counter-staff roles.
- A labelled live OCR corpus made from unseen menu sources.
- A selected POS vendor or the documented manual fallback tested at a venue.
- Legal review of privacy, terms, alcohol/RSA wording, billing, refund, and cancellation flows.
- Keyboard, screen reader, large-text, iPhone Safari, and Android Chrome checks on deployed pages.
- Production backup restore rehearsal and named incident owner.
- Apple signing/TestFlight/privacy declarations and Google Play signing/internal test/data-safety declarations.

Track each result in `docs/release-evidence.json`. A `pass` requires a non-empty evidence reference, verifier, and ISO timestamp.

```bash
npm run release:evidence
npm run release:evidence:strict
```

The first command reports status. The strict command fails until every required item has evidence-backed approval.
