# Pint Path Production Checklist (Superseded)

This legacy beta checklist is intentionally non-executable. It described the
retired SQLite production architecture and must not be used for a deployment,
rollback, database operation, or provider mutation.

Use only [`docs/production-launch-runbook.md`](docs/production-launch-runbook.md).
That runbook is the canonical ordered checklist for the web and iOS release,
including immutable release identity, protected Railway executors, Postgres
cutover, backup/restore proof, smoke tests, external sign-offs, and rollback.
All gates remain fail-closed until their candidate-bound evidence is current.
