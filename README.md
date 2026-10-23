# @invoance/audit-viewer

Embed the Invoance audit-log viewer in your own product: the signed event
table, filters, CSV/JSON export, and the in-browser Ed25519 tamper test, as a
native React component. No iframe. The data comes from the Invoance API; the
cryptographic verification runs in your user's browser via Web Crypto, so the
proof does not depend on trusting the page that renders it.

## Install

```bash
npm install @invoance/audit-viewer
```

React 18+ is a peer dependency. The package ships compiled, `inv-`-prefixed
CSS with no reset, so it cannot fight your app's styles; you do not need
Tailwind.

## Quick start

```tsx
import { AuditLogViewer } from "@invoance/audit-viewer";
import "@invoance/audit-viewer/styles.css";

export function AuditPage() {
    return (
        <AuditLogViewer
            getPortalToken={async () => {
                const r = await fetch("/api/audit-portal-token", { method: "POST" });
                return (await r.json()).token;
            }}
        />
    );
}
```

Your backend mints the token server-side with your API key (never expose the
API key to the browser):

```ts
// e.g. an authenticated route in your app's backend
const session = await client.audit.portalSessions.create({
    organization_id: currentCustomerOrgId,
    intent: "audit_logs",
    session_duration_seconds: 3600,
});
return { token: session.token };
```

## Auth

- `getPortalToken` is an async callback, not a static prop. The component
  invokes it on mount and again whenever the session JWT expires, so short
  `session_duration_seconds` values are free; sessions are cheap to re-mint.
- The exchanged JWT is org-scoped: it can only ever read the one organization
  the session was minted for.
- `tokenFromUrl` enables the hosted-page style instead: the component reads a
  one-time `?token=` from the URL, shows an "Open audit log" button, and
  exchanges the token only when the visitor clicks it, then strips it from the
  URL. Links are single-use, and mail scanners (Microsoft Defender Safe Links
  and similar) render pages on delivery; exchanging on load would burn the
  link before the person arrives. Loading the page posts nothing. Combine with
  `persistSession` to survive page refreshes via sessionStorage: a refresh
  after opening reuses the stored session without the button.
- `confirmBeforeOpen={false}` restores the exchange on page load for
  `tokenFromUrl`, for links that are never sent by email. The
  `getPortalToken` path is always automatic; the button never shows there.
- A session minted with `intent: "log_streams"` renders the stream-destination
  config screen instead of the event viewer.

## Props

| Prop | Default | What it does |
|---|---|---|
| `getPortalToken` | - | Async callback returning a fresh one-time portal token |
| `tokenFromUrl` | `false` | Read and strip `?token=` from the page URL |
| `confirmBeforeOpen` | `true` | With `tokenFromUrl`, exchange the token only after an "Open audit log" click |
| `persistSession` | `false` | Cache the session JWT in sessionStorage |
| `baseUrl` | `https://api.invoance.com` | API origin (point at your dev backend) |
| `pageSize` | `25` | Initial rows per page (25, 50, or 100) |
| `autoRefresh` | `true` | Quietly re-pull page 1 every 15s while idle |
| `theme` | - | CSS-variable overrides, see Theming |
| `className` | - | Extra class(es) on the root element |
| `onSessionExpired` | - | Called when the session cannot be renewed |
| `syncUrl` | `true` | Keep the open event, filters and page in the page URL |
| `urlParamPrefix` | `""` | Prefix for the viewer's URL params, e.g. `"audit_"` |

## Filters

One filter bar replaces separate inputs. Empty, it reads "Filter by actors,
actions, targets and dates" and the whole bar opens a menu of
fields: actor name, actor id, action, target (type), target id and date.
Picking a field lists the values that exist, most used first, with a search
box that narrows by prefix; picking a value adds a chip such as
`action: document.deleted`.

- Chips on different fields combine with AND. Several action chips mean any
  of those actions. Every other field holds one value, so a second pick
  replaces the first.
- Date offers Today, Last 7, 14 and 30 days (rolling, so Live keeps finding
  new events) and a custom range of two calendar days.
- Typing a value that is not in the list offers "Filter by ..." for it.
- Suggestions come from `GET /v1/audit/portal/facets`. Against an API that
  predates that endpoint the viewer suggests from the rows already loaded and
  leaves out actor name and target, which such an API does not filter on.

## Event detail

Clicking a row opens the event inside the component, in place of the list.
The breadcrumb ("Audit log / <event id>"), Escape or the browser's Back
returns to the list with the filters and page as they were.

The card shows the actor, the action and event id, the date and time with
the reader's timezone, the targets, and the location and user agent. Each is
a button that highlights its lines in the full signed record beside it. The
record wraps long values instead of scrolling, and you can type into it to
test tampering (append-only; Reset restores it). Along the bottom, the sealed
payload hash and the Ed25519 signature, with Verify signature checking both
in the browser.

## The page URL

With `syncUrl` (the default) the viewer keeps its state in the URL, so a
reload, a bookmark or Back lands in the same view:

```
?event=aevt_...&section=date              the open event and highlighted section
?action=a&action=b&actor_id=u1&date=7d    filters (date: today, 7d, 14d, 30d or 2026-10-01..2026-10-03)
?page=3&cursor=...&rows=50                the page and rows per page
```

Opening an event adds a history entry; filters and paging replace the
current one. Only these params are touched; the host page's own params are
kept. If your page already uses names such as `action` or `page`, set
`urlParamPrefix="audit_"`. Set `syncUrl={false}` when your app owns its URL.

## Theming

The stylesheet is driven by nine CSS variables (HSL triples, shadcn-style).
Override them on `:root`, on any ancestor, or through the `theme` prop:

```tsx
<AuditLogViewer
    getPortalToken={...}
    theme={{ variables: { background: "240 6% 12%", foreground: "0 0% 98%" } }}
/>
```

Variables: `--inv-background`, `--inv-foreground`, `--inv-border`,
`--inv-muted`, `--inv-popover`, `--inv-popover-foreground`, `--inv-success`,
`--inv-danger`, `--inv-warning`. Bare names in the `theme` prop get the
`--inv-` prefix automatically.

## Errors

- An invalid, expired, or already-used link renders a clear message instead of
  the viewer; mint a fresh session to recover.
- On a 401 mid-session the component re-invokes `getPortalToken` once and
  retries; if that fails it shows the expiry message and calls
  `onSessionExpired`.
- In browsers whose Web Crypto lacks Ed25519 (older Safari/Firefox), the
  tamper test still checks the hash and reports the signature as not
  verifiable in this browser, distinct from a failed verification.

## Offline verification

The verification primitives are exported for your own use:

```ts
import { verifyAuditEventDetail, canonicalAuditBytes } from "@invoance/audit-viewer";
```

`verifyAuditEventDetail(event)` rebuilds the frozen `invoance.audit/1`
canonical bytes, recomputes the SHA-256 payload hash, and checks the Ed25519
signature against the key embedded in the event, entirely client-side.
