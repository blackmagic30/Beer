# Pint Path Deployment Checklist (Superseded)

This legacy beta checklist is intentionally non-executable. It described the
retired SQLite production architecture and must not be used for a deployment,
rollback, database operation, or provider mutation.

The only controlling deployment sequence is
[`docs/production-launch-runbook.md`](docs/production-launch-runbook.md). Its
Railway mutation-boundary, immutable-candidate, Postgres migration, recovery,
evidence, and rollback requirements apply in full. No instruction in Git
history or an older checklist can waive those gates.
