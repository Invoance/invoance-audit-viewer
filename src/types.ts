export type Actor = { type?: string; id?: string; name?: string } | null;
export type Target = { type?: string; id?: string };
export type EventContext = { location?: string; user_agent?: string } | null;

export type AuditEvent = {
    id: string;
    seq: number;
    occurred_at: string;
    ingested_at: string;
    action: string;
    actor: Actor;
    targets: Target[] | null;
    context: EventContext;
    metadata: Record<string, unknown> | null;
    payload_hash: string;
    signature: string;
    signing_public_key: string;
};

export type Brand = {
    issuer: { name: string | null; logo_url: string | null; domain_verified: boolean };
    org: { name: string; organization_id: string };
    intent: string;
} | null;

/** Portal fetch bound to the current session. Path is relative to
    `/v1/audit/portal`. Resolves to null when the session expired and could not
    be refreshed; the viewer has already shown the expiry message. */
export type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response | null>;

export type ThemeVariables = Record<string, string>;

export type AuditLogViewerProps = {
    /** Fetch a fresh one-time portal token from YOUR backend (which mints it
        server-side with the API key). Re-invoked automatically when the portal
        session expires. The Stripe fetchClientSecret pattern. */
    getPortalToken?: () => Promise<string>;
    /** Read the one-time token from the page URL's `?token=` (hosted-page
        style). The token is exchanged then stripped from the URL. Default false. */
    tokenFromUrl?: boolean;
    /** Cache the session JWT in sessionStorage so a page refresh survives
        without a fresh token. Default false; the hosted page turns it on. */
    persistSession?: boolean;
    /** API origin. Default https://api.invoance.com; point at your dev backend
        while developing. */
    baseUrl?: string;
    /** Initial rows per page (the visitor can change it). Default 25. */
    pageSize?: 25 | 50 | 100;
    /** Quietly re-pull page 1 every 15s while idle. Default true. */
    autoRefresh?: boolean;
    /** Extra class(es) for the root element. */
    className?: string;
    /** CSS-variable overrides, e.g. { background: "240 6% 12%" } or
        { "--inv-foreground": "0 0% 98%" }. Bare names get the --inv- prefix. */
    theme?: { variables?: ThemeVariables };
    /** Called when the session expired and could not be refreshed. */
    onSessionExpired?: () => void;
};
