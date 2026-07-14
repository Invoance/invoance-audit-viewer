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
  one-time `?token=` from the URL, exchanges it, and strips it. Combine with
  `persistSession` to survive page refreshes via sessionStorage.
- A session minted with `intent: "log_streams"` renders the stream-destination
  config screen instead of the event viewer.

## Props

| Prop | Default | What it does |
|---|---|---|
| `getPortalToken` | - | Async callback returning a fresh one-time portal token |
| `tokenFromUrl` | `false` | Read and strip `?token=` from the page URL |
| `persistSession` | `false` | Cache the session JWT in sessionStorage |
| `baseUrl` | `https://api.invoance.com` | API origin (point at your dev backend) |
| `pageSize` | `25` | Initial rows per page (25, 50, or 100) |
| `autoRefresh` | `true` | Quietly re-pull page 1 every 15s while idle |
| `theme` | - | CSS-variable overrides, see Theming |
| `className` | - | Extra class(es) on the root element |
| `onSessionExpired` | - | Called when the session cannot be renewed |

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
