# Legacy Call Automation Archive

This folder contains the retired Twilio/ElevenLabs phone-call prototype.

It is intentionally outside the active `src/`, `scripts/`, and `test/` trees:

- It is not built by `npm run build`.
- It is not mounted by the Express app.
- It is not covered by the active Vitest suite.
- Its provider dependencies have been removed from `package.json`.
- The old standalone `server.cjs` entrypoint is archived here too; Railway uses
  `node dist/src/server.js` from the active TypeScript app.

Keep it only as historical reference. If phone automation ever returns, rebuild it as a new, security-reviewed feature with fresh provider credentials, tests, consent/privacy review, and deployment documentation.
