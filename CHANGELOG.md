# Changelog

## 0.1.0

Initial release.

- `AuditLogViewer`: signed event table (actor, targets, action, gap-free seq),
  filter bar, keyset paging, CSV/JSON export with formula-injection-safe cells,
  15s auto-refresh, issuer branding header.
- Detail drawer with the raw signed event, append-only tamper editor, and the
  step-by-step in-browser verification (SHA-256 payload hash + Ed25519
  signature via Web Crypto).
- Auth: `getPortalToken` callback with single-flight renewal on 401;
  `tokenFromUrl` + `persistSession` for hosted-style embeds; StrictMode-safe
  one-time exchange (in-flight dedup keyed by token).
- Ed25519 feature detection: browsers without Web Crypto Ed25519 report the
  signature as not verifiable, distinct from a failed verification.
- Stream-config screen for sessions minted with `intent: "log_streams"`.
- Compiled `inv-`-prefixed stylesheet (no preflight), themed by 9 CSS
  variables; dark themes via variable overrides.
- Exported primitives: `verifyAuditEventDetail`, `canonicalAuditBytes`,
  `exchangePortalToken`.
- Conformance: golden-vector suite against the frozen `invoance.audit/1`
  canonicalization (14/15 vectors; the int64-beyond-2^53 vector is out of
  scope in JS, same as the Node SDK).
