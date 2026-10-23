# Changelog

## 0.2.2

- The empty filter bar reads like a search field's placeholder, "Filter by
  actors, actions, targets and dates", and the whole bar is the button that
  opens the field menu. With filters set it shows the chips and "Add filter"
  as before.

## 0.2.1

- The signed record's editable layer stays aligned with the coloured text
  under host page CSS. In 0.2.0 a host rule such as `textarea { font-size:
  16px !important }` (iOS zoom prevention, as in the Invoance dashboard) made
  the transparent textarea larger than the copy beneath it, and a global
  `::selection { color: white }` made its text visible when selected, so a
  selection showed a second, offset copy of the record. Both layers now take
  their whole typography and box model from one rule (`.inv-record-layer`),
  explicit and `!important` at a specificity bare element rules cannot reach;
  selecting shows only a background behind the coloured text.
- The demo has a second page, `host.html`, rendering the viewer under Tailwind
  preflight plus those dashboard rules.

## 0.2.0

Redesign of the list and the detail view.

- One filter bar of chips replaces the Action, Actor id, From and To inputs.
  Fields: actor name, actor id, action, target (type), target id, date. Values
  come from the new `GET /v1/audit/portal/facets` endpoint, most used first,
  narrowed by a typed prefix. Several action chips mean any of them; other
  fields hold one value. Date presets: Today, Last 7, 14 and 30 days, and a
  custom range. New list params `actor_name` and `target_type`.
- Older APIs: when facets is missing (a 404, or a blocked cross-origin
  preflight) suggestions come from the loaded rows, and actor name and target
  are left out of the menu.
- Table rows: actor name over actor type, action over the first target's name
  (with "+N" for more targets), and the date over the time with the reader's
  timezone, with a chevron.
- The pager is the table card's footer. Rows is hidden while one page of 25
  holds every event, and its menu opens above when there is no room below.
- The detail view opens in place of the list, with a breadcrumb back. One card:
  clickable sections that highlight their lines in the signed record; the
  record sized to its content with long values wrapped; the signature check
  along the bottom. The tamper test stays (append-only edits, Reset).
- The open event, its section, the filters, the page and the rows per page are
  kept in the page URL (`syncUrl`, default true; `urlParamPrefix` for host
  pages that use the same names). Opening an event adds a history entry, so
  Back returns to the list.
- Square corners throughout, a wider layout (`max-w-6xl`), and a small scoped
  reset so native buttons, lists and borders render as designed without a
  host-page reset.

## 0.1.3

- `tokenFromUrl` links now open on a click. The viewer shows an "Open audit
  log" button and exchanges the one-time `?token=` only when the visitor
  clicks it; loading the page posts nothing. Mail scanners that render links
  on delivery (Microsoft Defender Safe Links and similar) no longer burn the
  link before the person arrives. A refresh after opening still reuses the
  stored session (`persistSession`) without the button.
- New prop `confirmBeforeOpen` (default `true`); set it to `false` to exchange
  on load as before. The `getPortalToken` callback path is unchanged and
  stays automatic.

## 0.1.2

- Exchange retries automatically on 429 (per-IP rate limit), honoring
  Retry-After, up to 2 attempts. A rate-limit rejection does not consume the
  one-time link, so the retry is safe; if the budget is exhausted the error
  now says the server is busy instead of misreporting the link as invalid or
  already used.

## 0.1.1

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
