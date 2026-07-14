// The embeddable audit-log viewer.
//
// Extracted from the hosted portal page (webs/backend/app/portal), same UI and
// the same trust features: signed event table, filters, keyset paging, CSV/JSON
// export, and the in-browser Ed25519 tamper test. Differences from the hosted
// page are the token plumbing (getPortalToken callback as the primary mode,
// ?token= URL mode as opt-in), a configurable API base URL, and inv--prefixed
// utility classes served by the package stylesheet.
//
// - All event values render as TEXT (React escapes), so this is XSS-safe.
// - Paging: the backend is keyset (forward) only, so Prev uses a client-side
//   cursor stack (we remember the cursor that loaded each page).
// - On 401 the session silently re-mints through getPortalToken when provided;
//   otherwise the expiry message asks for a fresh link.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from "./icons";
import { verifyAuditEventDetail } from "./auditVerify";
import { DEFAULT_BASE_URL, exchangePortalToken, portalBase } from "./portalClient";
import StreamConfig from "./StreamConfig";
import type {
    Actor,
    AuditEvent,
    AuditLogViewerProps,
    AuthedFetch,
    Brand,
    EventContext,
    Target,
} from "./types";

type Filters = { action: string; actor: string; after: string; before: string };
const EMPTY_FILTERS: Filters = { action: "", actor: "", after: "", before: "" };

const SS_KEY = "invoance_portal_jwt";
const PAGE_SIZES = [25, 50, 100];

// No focus ring on click; inputs get a subtle border-focus instead.
const NO_RING =
    "inv-outline-none focus:inv-outline-none focus:inv-ring-0 focus-visible:inv-outline-none focus-visible:inv-ring-0 active:inv-outline-none";
const INPUT_FOCUS = "inv-outline-none focus:inv-outline-none focus:inv-border-foreground/40";

function actorPrimary(a: Actor): string {
    if (!a) return "-";
    return a.name || a.id || (a.type ? a.type : "-");
}
function actorSecondary(a: Actor, ctx: EventContext): string {
    const parts: string[] = [];
    if (a?.name && a?.id) parts.push(a.id);
    if (ctx?.location) parts.push(ctx.location);
    return parts.join("  •  ");
}
function fmtTime(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
}
function targetChips(targets: Target[] | null): string {
    if (!Array.isArray(targets) || targets.length === 0) return "-";
    return targets.map((t) => (t?.type ? `${t.type}:${t.id ?? "?"}` : t?.id ?? "?")).join(", ");
}

// Decode the `intent` claim from the portal JWT (no signature check, UI branch
// only; the backend enforces intent on every stream/read endpoint).
function jwtIntent(jwt: string): string | null {
    try {
        let seg = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        seg += "=".repeat((4 - (seg.length % 4)) % 4);
        const claims = JSON.parse(atob(seg));
        return typeof claims.intent === "string" ? claims.intent : null;
    } catch {
        return null;
    }
}

// CSV/JSON export helpers (client-side, flat schema for auditors).
function csvCell(v: unknown): string {
    let s = v == null ? "" : String(v);
    // Neutralize spreadsheet formula injection: a leading = + - @ (or tab/CR)
    // gets a single-quote prefix so the cell is treated as text, not a formula.
    const danger = s.length > 0 && "=+-@\t\r".includes(s[0]);
    if (danger) s = "'" + s;
    return danger || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_COLS = [
    "seq", "occurred_at", "ingested_at", "action",
    "actor_type", "actor_id", "actor_name", "targets",
    "location", "user_agent", "payload_hash", "signature",
];
function toCsv(events: AuditEvent[]): string {
    const lines = [CSV_COLS.join(",")];
    for (const e of events) {
        lines.push(
            [
                e.seq, e.occurred_at, e.ingested_at, e.action,
                e.actor?.type ?? "", e.actor?.id ?? "", e.actor?.name ?? "",
                (e.targets ?? []).map((t) => `${t?.type ?? ""}:${t?.id ?? ""}`).join("|"),
                e.context?.location ?? "", e.context?.user_agent ?? "",
                e.payload_hash, e.signature,
            ]
                .map(csvCell)
                .join(","),
        );
    }
    return lines.join("\r\n");
}
function downloadFile(filename: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/** Strip ONLY the token param; an embedding page may have its own params. */
function stripTokenFromUrl() {
    const u = new URL(window.location.href);
    u.searchParams.delete("token");
    const qs = u.searchParams.toString();
    window.history.replaceState({}, "", u.pathname + (qs ? `?${qs}` : "") + u.hash);
}

// Initial acquisition through the callback, deduped at module level by the
// callback's identity: StrictMode's double-mount must not mint two sessions.
const acquireInFlight = new WeakMap<() => Promise<string>, Promise<string>>();
function acquireViaCallback(baseUrl: string, getPortalToken: () => Promise<string>): Promise<string> {
    const existing = acquireInFlight.get(getPortalToken);
    if (existing) return existing;
    const p = (async () => {
        const token = await getPortalToken();
        return exchangePortalToken(baseUrl, token);
    })();
    acquireInFlight.set(getPortalToken, p);
    p.catch(() => acquireInFlight.delete(getPortalToken));
    return p;
}

function Centered({ children }: { children: ReactNode }) {
    return (
        <div className="inv-flex inv-items-center inv-justify-center inv-p-6 inv-py-16 inv-text-sm inv-text-foreground/70">
            {children}
        </div>
    );
}

export default function AuditLogViewer({
    getPortalToken,
    tokenFromUrl = false,
    persistSession = false,
    baseUrl = DEFAULT_BASE_URL,
    pageSize: initialPageSize = 25,
    autoRefresh = true,
    className,
    theme,
    onSessionExpired,
}: AuditLogViewerProps) {
    const [jwt, setJwt] = useState<string | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [error, setError] = useState<string>("");
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [loading, setLoading] = useState(false);

    // paging: keyset cursor stack for Prev/Next
    const [pageSize, setPageSize] = useState<number>(initialPageSize);
    const [pageCursors, setPageCursors] = useState<(string | null)[]>([null]);
    const [pageIndex, setPageIndex] = useState(0);
    const [nextCursor, setNextCursor] = useState<string | null>(null);

    // filters: draft (form) vs applied (drives the query)
    const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
    const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

    const [selected, setSelected] = useState<AuditEvent | null>(null);
    const [exporting, setExporting] = useState<null | "csv" | "json">(null);
    const [brand, setBrand] = useState<Brand>(null);

    const base = portalBase(baseUrl);
    const jwtRef = useRef<string | null>(null);
    jwtRef.current = jwt;
    const refreshRef = useRef<Promise<string | null> | null>(null);

    const expire = useCallback(() => {
        try {
            sessionStorage.removeItem(SS_KEY);
        } catch {
            /* storage unavailable */
        }
        setStatus("error");
        setError(
            getPortalToken
                ? "Your audit-log session could not be renewed. Please reload."
                : "Your portal session has expired. Open a fresh link to continue.",
        );
        onSessionExpired?.();
    }, [getPortalToken, onSessionExpired]);

    const storeJwt = useCallback(
        (j: string) => {
            if (persistSession) {
                try {
                    sessionStorage.setItem(SS_KEY, j);
                } catch {
                    /* storage unavailable */
                }
            }
            setJwt(j);
            jwtRef.current = j;
        },
        [persistSession],
    );

    // Single-flight session renewal through the callback.
    const refreshJwt = useCallback(async (): Promise<string | null> => {
        if (!getPortalToken) return null;
        if (!refreshRef.current) {
            refreshRef.current = (async () => {
                try {
                    const token = await getPortalToken();
                    const j = await exchangePortalToken(baseUrl, token);
                    storeJwt(j);
                    return j;
                } catch {
                    return null;
                } finally {
                    refreshRef.current = null;
                }
            })();
        }
        return refreshRef.current;
    }, [getPortalToken, baseUrl, storeJwt]);

    // Portal fetch bound to the session: attaches the Bearer JWT, renews once
    // on 401 when a callback exists, and resolves null after handling expiry.
    const authedFetch = useCallback<AuthedFetch>(
        async (path, init) => {
            const current = jwtRef.current;
            if (!current) return null;
            const doFetch = (token: string) =>
                fetch(`${base}${path}`, {
                    ...init,
                    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
                });
            let res = await doFetch(current);
            if (res.status === 401) {
                const fresh = await refreshJwt();
                if (fresh) res = await doFetch(fresh);
                if (res.status === 401) {
                    expire();
                    return null;
                }
            }
            return res;
        },
        [base, refreshJwt, expire],
    );

    // 1) Obtain the portal JWT. Order: a fresh ?token= (when tokenFromUrl)
    //    always wins, then a stored session (when persistSession), then the
    //    getPortalToken callback.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (tokenFromUrl) {
                const token = new URLSearchParams(window.location.search).get("token");
                if (token) {
                    try {
                        const j = await exchangePortalToken(baseUrl, token);
                        stripTokenFromUrl();
                        if (!cancelled) storeJwt(j);
                    } catch (e) {
                        if (!cancelled) {
                            setStatus("error");
                            setError(e instanceof Error ? e.message : "Could not start the session.");
                        }
                    }
                    return;
                }
            }
            if (persistSession) {
                let stored: string | null = null;
                try {
                    stored = sessionStorage.getItem(SS_KEY);
                } catch {
                    /* storage unavailable */
                }
                if (stored) {
                    if (!cancelled) storeJwt(stored);
                    return;
                }
            }
            if (getPortalToken) {
                try {
                    const j = await acquireViaCallback(baseUrl, getPortalToken);
                    if (!cancelled) storeJwt(j);
                } catch (e) {
                    if (!cancelled) {
                        setStatus("error");
                        setError(e instanceof Error ? e.message : "Could not start the session.");
                    }
                }
                return;
            }
            if (!cancelled) {
                setStatus("error");
                setError(
                    tokenFromUrl
                        ? "This portal link is missing its token."
                        : "No token source: pass getPortalToken or set tokenFromUrl.",
                );
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The portal link's intent decides the surface: log_streams = stream
    // config, anything else = the event viewer.
    const intent = jwt ? jwtIntent(jwt) : null;
    const isStreams = intent === "log_streams";
    const issuerName = brand?.issuer?.name || null;
    const headerTitle = issuerName
        ? `${issuerName} ${isStreams ? "log streams" : "audit log"}`
        : isStreams
          ? "Log streams"
          : "Audit log";
    const headerSubtitle = isStreams
        ? brand?.org?.name
            ? `Stream ${brand.org.name}'s events to your systems`
            : "Configure your event stream destinations"
        : brand?.org?.name
          ? `Activity for ${brand.org.name}`
          : "Signed, independently verifiable activity for your organization.";

    // Best-effort branding for the header (issuer logo/name + org name).
    useEffect(() => {
        if (!jwt) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await authedFetch("/org");
                if (!res || !res.ok) return;
                const b = await res.json().catch(() => null);
                if (!cancelled && b) setBrand(b);
            } catch {
                // branding is optional; ignore failures
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [jwt, authedFetch]);

    const buildQuery = useCallback(
        (limit: number, cursor: string | null) => {
            const qs = new URLSearchParams();
            qs.set("limit", String(limit));
            if (applied.action.trim()) qs.set("actions", applied.action.trim());
            if (applied.actor.trim()) qs.set("actor_id", applied.actor.trim());
            if (applied.after) qs.set("occurred_after", new Date(applied.after).toISOString());
            if (applied.before) qs.set("occurred_before", new Date(applied.before).toISOString());
            if (cursor) qs.set("cursor", cursor);
            return qs;
        },
        [applied],
    );

    // Fetch ONE page at the given cursor (replaces the visible rows).
    const fetchPage = useCallback(
        async (cursor: string | null) => {
            if (!jwtRef.current) return;
            setLoading(true);
            try {
                const res = await authedFetch(`/events?${buildQuery(pageSize, cursor).toString()}`);
                if (!res) return; // expired, handled
                const b = await res.json().catch(() => null);
                if (!res.ok || !b) {
                    setStatus("error");
                    setError("Could not load audit events.");
                    return;
                }
                setEvents(b.events || []);
                setNextCursor(b.next_cursor || null);
                setStatus("ready");
            } catch {
                setStatus("error");
                setError("Could not load audit events.");
            } finally {
                setLoading(false);
            }
        },
        [authedFetch, buildQuery, pageSize],
    );

    // Reset to page 1 whenever the JWT, the applied filters, or page size change.
    useEffect(() => {
        if (!jwt) return;
        if (isStreams) {
            // The streams screen loads its own data; nothing to fetch here.
            setStatus("ready");
            return;
        }
        setPageCursors([null]);
        setPageIndex(0);
        fetchPage(null);
    }, [jwt, isStreams, fetchPage]);

    function goNext() {
        if (!nextCursor || loading) return;
        const cursors = [...pageCursors.slice(0, pageIndex + 1), nextCursor];
        setPageCursors(cursors);
        setPageIndex(pageIndex + 1);
        fetchPage(nextCursor);
    }
    function goPrev() {
        if (pageIndex === 0 || loading) return;
        const idx = pageIndex - 1;
        setPageIndex(idx);
        fetchPage(pageCursors[idx]);
    }

    // Background auto-refresh: while on page 1 with no detail open, quietly
    // re-pull the newest events every 15s. Rows are keyed by id so only
    // genuinely new rows mount. Pauses while paging, reading a detail, or when
    // the tab is hidden; never flips to an error on a transient poll failure.
    useEffect(() => {
        if (!autoRefresh || !jwt || isStreams || pageIndex !== 0 || selected) return;
        let cancelled = false;
        const tick = async () => {
            if (document.visibilityState !== "visible") return;
            try {
                const res = await authedFetch(`/events?${buildQuery(pageSize, null).toString()}`);
                if (cancelled || !res || !res.ok) return;
                const b = await res.json().catch(() => null);
                if (!b || cancelled) return;
                setEvents(b.events || []);
                setNextCursor(b.next_cursor || null);
            } catch {
                // transient network blip: ignore, the next tick retries
            }
        };
        const id = setInterval(tick, 15000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [autoRefresh, jwt, isStreams, pageIndex, selected, authedFetch, buildQuery, pageSize]);

    // Export: walk the cursor to pull every row matching the CURRENT filter
    // (capped), then download as CSV or JSON.
    async function fetchAllMatching(): Promise<AuditEvent[] | null> {
        if (!jwtRef.current) return null;
        const MAX_ROWS = 10000;
        const all: AuditEvent[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 200; i++) {
            const res = await authedFetch(`/events?${buildQuery(100, cursor).toString()}`);
            if (!res) return null;
            const b = await res.json().catch(() => null);
            if (!res.ok || !b) return null;
            all.push(...((b.events as AuditEvent[]) || []));
            cursor = b.next_cursor || null;
            if (!cursor || all.length >= MAX_ROWS) break;
        }
        return all.slice(0, MAX_ROWS);
    }

    async function exportAs(kind: "csv" | "json") {
        if (exporting || loading) return;
        setExporting(kind);
        try {
            const all = await fetchAllMatching();
            if (!all) return;
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
            if (kind === "json") {
                downloadFile(`audit-log-${stamp}.json`, JSON.stringify(all, null, 2), "application/json");
            } else {
                downloadFile(`audit-log-${stamp}.csv`, toCsv(all), "text/csv;charset=utf-8");
            }
        } finally {
            setExporting(null);
        }
    }

    const themeStyle = useMemo<CSSProperties | undefined>(() => {
        const vars = theme?.variables;
        if (!vars) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(vars)) {
            out[k.startsWith("--") ? k : `--inv-${k}`] = v;
        }
        return out as CSSProperties;
    }, [theme]);

    const root = (children: ReactNode) => (
        <div
            className={`inv-mx-auto inv-max-w-5xl inv-bg-background inv-px-6 inv-py-8 inv-text-foreground${className ? ` ${className}` : ""}`}
            style={themeStyle}
        >
            {children}
        </div>
    );

    if (status === "loading") return root(<Centered>Loading your audit log…</Centered>);
    if (status === "error") return root(<Centered>{error}</Centered>);

    return root(
        <>
            <header className="inv-mb-5 inv-flex inv-items-center inv-justify-between inv-gap-4">
                <div>
                    <h1 className="inv-text-xl inv-font-semibold inv-tracking-tight">{headerTitle}</h1>
                    <p className="inv-text-sm inv-text-foreground/60">{headerSubtitle}</p>
                </div>
                {brand?.issuer?.logo_url && (
                    <img
                        src={brand.issuer.logo_url}
                        alt={issuerName ? `${issuerName} logo` : "logo"}
                        className="inv-h-10 inv-w-auto inv-max-w-[180px] inv-shrink-0 inv-object-contain"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                            e.currentTarget.style.display = "none";
                        }}
                    />
                )}
            </header>

            {isStreams ? (
                <StreamConfig fetcher={authedFetch} />
            ) : (
                <>
                    {/* Filter bar */}
                    <div className="inv-mb-4 inv-flex inv-flex-wrap inv-items-end inv-justify-between inv-gap-3">
                        <form
                            className="inv-flex inv-flex-wrap inv-items-end inv-gap-3"
                            onSubmit={(e) => {
                                e.preventDefault();
                                setApplied(draft);
                            }}
                        >
                            <Field label="Action">
                                <input
                                    value={draft.action}
                                    onChange={(e) => setDraft({ ...draft, action: e.target.value })}
                                    placeholder="user.signed_in"
                                    className={`inv-w-44 inv-rounded inv-border inv-border-border inv-bg-background inv-px-2 inv-py-1 inv-text-sm ${INPUT_FOCUS}`}
                                />
                            </Field>
                            <Field label="Actor id">
                                <input
                                    value={draft.actor}
                                    onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
                                    placeholder="user_123"
                                    className={`inv-w-40 inv-rounded inv-border inv-border-border inv-bg-background inv-px-2 inv-py-1 inv-text-sm ${INPUT_FOCUS}`}
                                />
                            </Field>
                            <Field label="From">
                                <input
                                    type="date"
                                    value={draft.after}
                                    onChange={(e) => setDraft({ ...draft, after: e.target.value })}
                                    className={`inv-rounded inv-border inv-border-border inv-bg-background inv-px-2 inv-py-1 inv-text-sm ${INPUT_FOCUS}`}
                                />
                            </Field>
                            <Field label="To">
                                <input
                                    type="date"
                                    value={draft.before}
                                    onChange={(e) => setDraft({ ...draft, before: e.target.value })}
                                    className={`inv-rounded inv-border inv-border-border inv-bg-background inv-px-2 inv-py-1 inv-text-sm ${INPUT_FOCUS}`}
                                />
                            </Field>
                            <button
                                type="submit"
                                className={`inv-rounded-md inv-border inv-border-border inv-px-3 inv-py-1.5 inv-text-sm hover:inv-bg-muted ${NO_RING}`}
                            >
                                Filter
                            </button>
                            {(applied.action || applied.actor || applied.after || applied.before) && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setDraft(EMPTY_FILTERS);
                                        setApplied(EMPTY_FILTERS);
                                    }}
                                    className={`inv-rounded-md inv-px-2 inv-py-1.5 inv-text-sm inv-text-foreground/60 hover:inv-text-foreground ${NO_RING}`}
                                >
                                    Clear
                                </button>
                            )}
                        </form>
                        <div className="inv-flex inv-items-end">
                            <ExportMenu
                                exporting={exporting}
                                disabled={exporting !== null || loading}
                                onExport={exportAs}
                            />
                        </div>
                    </div>

                    <div className="inv-overflow-hidden inv-rounded-md inv-border inv-border-border">
                        <div className="inv-grid inv-grid-cols-[1fr_1fr_180px] inv-gap-3 inv-border-b inv-border-border inv-bg-muted/40 inv-px-4 inv-py-2 inv-text-xs inv-font-medium inv-text-foreground/60">
                            <span>Actor</span>
                            <span>Action</span>
                            <span>Date and time</span>
                        </div>

                        {events.length === 0 ? (
                            <div className="inv-px-4 inv-py-8 inv-text-sm inv-text-foreground/60">No events match.</div>
                        ) : (
                            <div className="inv-divide-y inv-divide-border">
                                {events.map((e) => (
                                    <button
                                        key={e.id}
                                        onClick={() => setSelected(e)}
                                        className={`inv-grid inv-w-full inv-grid-cols-[1fr_1fr_180px] inv-items-center inv-gap-3 inv-px-4 inv-py-3 inv-text-left inv-text-sm hover:inv-bg-muted/40 ${NO_RING}`}
                                    >
                                        <span className="inv-min-w-0">
                                            <span className="inv-block inv-truncate">{actorPrimary(e.actor)}</span>
                                            <span className="inv-block inv-truncate inv-text-xs inv-text-foreground/50">
                                                {actorSecondary(e.actor, e.context)}
                                            </span>
                                        </span>
                                        <span className="inv-min-w-0">
                                            <span className="inv-block inv-truncate inv-font-mono inv-text-[13px]">{e.action}</span>
                                            <span className="inv-block inv-truncate inv-text-xs inv-text-foreground/50">
                                                {targetChips(e.targets)}
                                            </span>
                                        </span>
                                        <span className="inv-text-foreground/70" title={e.occurred_at}>
                                            {fmtTime(e.occurred_at)}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Pager */}
                    <div className="inv-mt-4 inv-flex inv-items-center inv-justify-between">
                        <label className="inv-flex inv-items-center inv-gap-2 inv-text-sm inv-text-foreground/60">
                            Rows
                            <PageSizeDropdown value={pageSize} onChange={(n) => setPageSize(n)} />
                        </label>
                        <div className="inv-flex inv-items-center inv-gap-3 inv-text-sm">
                            {autoRefresh && pageIndex === 0 && !selected && (
                                <span
                                    className="inv-flex inv-items-center inv-gap-1.5 inv-text-foreground/50"
                                    title="Auto-updating every 15s"
                                >
                                    <span className="inv-h-1.5 inv-w-1.5 inv-animate-pulse inv-rounded-full inv-bg-success" />
                                    Live
                                </span>
                            )}
                            <span className="inv-text-foreground/60">Page {pageIndex + 1}</span>
                            <button
                                onClick={goPrev}
                                disabled={pageIndex === 0 || loading}
                                className={`inv-rounded-md inv-border inv-border-border inv-px-3 inv-py-1.5 hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
                            >
                                Prev
                            </button>
                            <button
                                onClick={goNext}
                                disabled={!nextCursor || loading}
                                className={`inv-rounded-md inv-border inv-border-border inv-px-3 inv-py-1.5 hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </>
            )}

            {selected && <DetailDrawer event={selected} onClose={() => setSelected(null)} />}
        </>,
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="inv-flex inv-flex-col inv-gap-1">
            <span className="inv-text-xs inv-text-foreground/50">{label}</span>
            {children}
        </label>
    );
}

/* Custom page-size dropdown: themed, no focus ring, closes on outside-click or
   Escape. Opens upward since it sits at the page bottom. */
function PageSizeDropdown({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div ref={ref} className="inv-relative">
            <button
                type="button"
                onClick={() => setOpen((p) => !p)}
                className={`inv-flex inv-h-8 inv-min-w-[72px] inv-items-center inv-justify-between inv-gap-2 inv-rounded inv-border inv-border-border inv-bg-background inv-px-2.5 inv-text-sm inv-transition hover:inv-border-foreground/30 ${NO_RING}`}
            >
                <span>{value}</span>
                <ChevronDown
                    className={`inv-h-3.5 inv-w-3.5 inv-shrink-0 inv-text-foreground/50 inv-transition-transform ${open ? "inv-rotate-180" : ""}`}
                />
            </button>

            {open && (
                <div className="inv-absolute inv-bottom-full inv-left-0 inv-z-50 inv-mb-1 inv-min-w-[72px] inv-rounded inv-border inv-border-border inv-bg-popover inv-text-popover-foreground inv-shadow-lg">
                    <div className="inv-py-1">
                        {PAGE_SIZES.map((opt) => (
                            <button
                                key={opt}
                                type="button"
                                onClick={() => {
                                    onChange(opt);
                                    setOpen(false);
                                    (document.activeElement as HTMLElement)?.blur();
                                }}
                                className={`inv-flex inv-w-full inv-items-center inv-gap-2 inv-px-2.5 inv-py-1.5 inv-text-sm inv-transition hover:inv-bg-muted ${
                                    opt === value ? "inv-font-medium inv-text-foreground" : "inv-text-foreground/70"
                                } ${NO_RING}`}
                            >
                                <Check
                                    className={`inv-h-3.5 inv-w-3.5 inv-shrink-0 ${opt === value ? "inv-opacity-100" : "inv-opacity-0"}`}
                                />
                                {opt}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/* Export dropdown: one "Export" trigger with the CSV/JSON actions in a menu. */
function ExportMenu({
    exporting,
    disabled,
    onExport,
}: {
    exporting: null | "csv" | "json";
    disabled: boolean;
    onExport: (fmt: "csv" | "json") => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div ref={ref} className="inv-relative">
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen((p) => !p)}
                className={`inv-flex inv-items-center inv-gap-2 inv-rounded-md inv-border inv-border-border inv-px-3 inv-py-1.5 inv-text-sm hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
            >
                {exporting !== null ? "Exporting…" : "Export"}
                <ChevronDown
                    className={`inv-h-3.5 inv-w-3.5 inv-shrink-0 inv-text-foreground/50 inv-transition-transform ${open ? "inv-rotate-180" : ""}`}
                />
            </button>

            {open && (
                <div className="inv-absolute inv-right-0 inv-top-full inv-z-50 inv-mt-1 inv-min-w-[140px] inv-rounded inv-border inv-border-border inv-bg-popover inv-text-popover-foreground inv-shadow-lg">
                    <div className="inv-py-1">
                        {(["csv", "json"] as const).map((fmt) => (
                            <button
                                key={fmt}
                                type="button"
                                onClick={() => {
                                    setOpen(false);
                                    onExport(fmt);
                                }}
                                className={`inv-flex inv-w-full inv-items-center inv-px-2.5 inv-py-1.5 inv-text-sm inv-text-foreground/70 inv-transition hover:inv-bg-muted ${NO_RING}`}
                            >
                                Export {fmt.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// True when `original` is a subsequence of `candidate`: the candidate only ADDS
// characters, never removes or replaces one. This makes the editor append-only:
// you can type extra text into any field to test tampering, but you cannot
// delete the record or shorten a value.
function isInsertionOnly(original: string, candidate: string): boolean {
    if (candidate.length < original.length) return false;
    let i = 0;
    for (let j = 0; j < candidate.length && i < original.length; j++) {
        if (candidate[j] === original[i]) i++;
    }
    return i === original.length;
}

type VerifyState =
    | { kind: "json_error" }
    | {
          kind: "checked";
          recomputedHash: string;
          contentMatches: boolean;
          signatureChecked: boolean;
          signatureValid: boolean;
          ed25519Supported: boolean;
      };

function DetailDrawer({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
    const [jsonText, setJsonText] = useState("");
    const [verifying, setVerifying] = useState(false);
    const [result, setResult] = useState<VerifyState | null>(null);
    const originalRef = useRef("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Reset the editor and result whenever a different event is shown.
    useEffect(() => {
        const o = JSON.stringify(event, null, 2);
        originalRef.current = o;
        setJsonText(o);
        setResult(null);
    }, [event]);

    const edited = jsonText !== originalRef.current;
    const sealedHash = String((event as unknown as { payload_hash?: unknown }).payload_hash ?? "");

    // Append-only guard: accept the edit only if it adds characters.
    function onEdit(next: string) {
        if (isInsertionOnly(originalRef.current, next)) {
            setJsonText(next);
            setResult(null);
        }
    }

    function reset() {
        setJsonText(originalRef.current);
        setResult(null);
    }

    // The four chevrons scroll the detail field. It does not wrap, so long
    // lines (the signature, the hashes) run off to the right.
    function scrollField(dx: number, dy: number) {
        textareaRef.current?.scrollBy({ left: dx, top: dy, behavior: "smooth" });
    }

    async function verify() {
        setVerifying(true);
        setResult(null);
        try {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(jsonText);
            } catch {
                setResult({ kind: "json_error" });
                return;
            }
            const d = await verifyAuditEventDetail(parsed);
            setResult({
                kind: "checked",
                recomputedHash: d.recomputedHash,
                // Compare against the hash sealed when the record was signed, so
                // editing payload_hash in the box cannot make a tampered record pass.
                contentMatches: d.canonicalOk && sealedHash !== "" && d.recomputedHash === sealedHash,
                signatureChecked: d.signatureChecked,
                signatureValid: d.signatureValid,
                ed25519Supported: d.ed25519Supported,
            });
        } finally {
            setVerifying(false);
        }
    }

    return (
        <div className="inv-fixed inv-inset-0 inv-z-50 inv-flex inv-justify-end">
            {/* Opaque backdrop hides the list behind so the record is the focus. */}
            <div
                className="inv-absolute inv-inset-0 inv-bg-background/90 inv-backdrop-blur-sm"
                onClick={onClose}
                aria-hidden
            />
            <aside className="inv-relative inv-flex inv-h-full inv-w-full inv-max-w-3xl inv-flex-col inv-overflow-y-auto inv-border-l inv-border-border inv-bg-background inv-shadow-xl">
                <div className="inv-flex inv-items-start inv-justify-between inv-gap-4 inv-border-b inv-border-border inv-px-5 inv-py-4">
                    <div className="inv-min-w-0">
                        <div className="inv-truncate inv-font-mono inv-text-sm">{event.action}</div>
                        <div className="inv-text-xs inv-text-foreground/50">{fmtTime(event.occurred_at)}</div>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close"
                        className={`inv-shrink-0 inv-rounded-md inv-border inv-border-border inv-p-1 inv-text-foreground/60 hover:inv-bg-muted ${NO_RING}`}
                    >
                        <X className="inv-h-4 inv-w-4" />
                    </button>
                </div>

                <div className="inv-space-y-4 inv-px-5 inv-py-4 inv-text-sm">
                    <Row k="Event id" v={event.id} mono />
                    <Row k="Seq" v={String(event.seq)} />
                    <Row
                        k="Actor"
                        v={`${actorPrimary(event.actor)}${
                            actorSecondary(event.actor, event.context)
                                ? "  (" + actorSecondary(event.actor, event.context) + ")"
                                : ""
                        }`}
                    />
                    <Row k="Targets" v={targetChips(event.targets)} />
                    {event.context?.user_agent && <Row k="User agent" v={event.context.user_agent} />}

                    <div>
                        <div className="inv-mb-1 inv-flex inv-items-center inv-justify-between inv-gap-3">
                            <span className="inv-text-xs inv-font-medium inv-text-foreground/60">
                                Signed event (add text to any field to test tamper detection)
                            </span>
                            <div className="inv-flex inv-shrink-0 inv-items-center inv-gap-1">
                                <ScrollButton title="Scroll field up" onClick={() => scrollField(0, -160)}>
                                    <ChevronUp className="inv-h-3.5 inv-w-3.5" />
                                </ScrollButton>
                                <ScrollButton title="Scroll field down" onClick={() => scrollField(0, 160)}>
                                    <ChevronDown className="inv-h-3.5 inv-w-3.5" />
                                </ScrollButton>
                                <ScrollButton title="Scroll field left" onClick={() => scrollField(-160, 0)}>
                                    <ChevronLeft className="inv-h-3.5 inv-w-3.5" />
                                </ScrollButton>
                                <ScrollButton title="Scroll field right" onClick={() => scrollField(160, 0)}>
                                    <ChevronRight className="inv-h-3.5 inv-w-3.5" />
                                </ScrollButton>
                                <button
                                    type="button"
                                    onClick={reset}
                                    disabled={!edited}
                                    className={`inv-ml-1 inv-text-xs ${
                                        edited
                                            ? "inv-text-foreground/70 hover:inv-text-foreground"
                                            : "inv-cursor-not-allowed inv-text-foreground/25"
                                    } ${NO_RING}`}
                                >
                                    Reset
                                </button>
                            </div>
                        </div>
                        <textarea
                            ref={textareaRef}
                            value={jsonText}
                            onChange={(e) => onEdit(e.target.value)}
                            spellCheck={false}
                            wrap="off"
                            className={`inv-h-[50vh] inv-w-full inv-resize-y inv-overflow-auto inv-rounded-md inv-border inv-border-border inv-bg-muted/40 inv-p-3 inv-font-mono inv-text-xs inv-leading-relaxed [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:inv-hidden ${INPUT_FOCUS}`}
                        />
                        <p className="inv-mt-1 inv-text-[11px] inv-text-foreground/40">
                            Append-only: add characters to any value to test tampering, but the record
                            cannot be deleted or shortened. Use Reset to restore it.
                        </p>
                    </div>

                    {/* The sealed hash, shown before you verify. */}
                    <div className="inv-rounded-md inv-border inv-border-border inv-bg-muted/30 inv-px-3 inv-py-2 inv-text-xs">
                        <div className="inv-text-foreground/60">Hash sealed with this record when it was signed</div>
                        <code className="inv-mt-0.5 inv-block inv-break-all inv-font-mono inv-text-foreground/80">
                            {sealedHash || "(none)"}
                        </code>
                    </div>

                    <div>
                        <button
                            onClick={verify}
                            disabled={verifying}
                            className={`inv-rounded-md inv-border inv-border-border inv-px-3 inv-py-1.5 inv-text-sm hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
                        >
                            {verifying ? "Checking…" : "Verify signature"}
                        </button>

                        {result?.kind === "json_error" && (
                            <div className="inv-mt-3 inv-rounded-md inv-border inv-border-danger/50 inv-px-3 inv-py-2 inv-text-sm inv-text-danger">
                                The edited text is no longer valid JSON, so it cannot be checked. Use
                                Reset to restore the record.
                            </div>
                        )}

                        {result?.kind === "checked" &&
                            (() => {
                                const sigUnknowable = result.signatureChecked && !result.ed25519Supported;
                                const authentic = result.contentMatches && result.signatureValid;
                                const hashOnly = result.contentMatches && sigUnknowable;
                                return (
                                    <div className="inv-mt-3 inv-space-y-3 inv-rounded-md inv-border inv-border-border inv-bg-muted/30 inv-p-3 inv-text-xs">
                                        <Step n={1} label="Hash recomputed now from the content above">
                                            <code
                                                className={`inv-block inv-break-all inv-font-mono ${
                                                    result.contentMatches ? "inv-text-success" : "inv-text-danger"
                                                }`}
                                            >
                                                {result.recomputedHash || "(could not compute)"}
                                            </code>
                                        </Step>
                                        <Step n={2} label="Does it match the sealed hash above?">
                                            <span className={result.contentMatches ? "inv-text-success" : "inv-text-danger"}>
                                                {result.contentMatches
                                                    ? "Yes. The content is exactly what was signed."
                                                    : "No. A field was changed, so the content no longer matches the sealed hash."}
                                            </span>
                                        </Step>
                                        <Step n={3} label="Signature check (Ed25519, against the key in the record)">
                                            <span
                                                className={
                                                    sigUnknowable
                                                        ? "inv-text-warning"
                                                        : result.signatureValid
                                                          ? "inv-text-success"
                                                          : "inv-text-danger"
                                                }
                                            >
                                                {!result.signatureChecked
                                                    ? "No signature present to check."
                                                    : sigUnknowable
                                                      ? "Not verifiable in this browser: its Web Crypto lacks Ed25519. The hash check above still stands."
                                                      : result.signatureValid
                                                        ? "Valid. The signature fits the content."
                                                        : "Does not match. The signature no longer fits the content."}
                                            </span>
                                        </Step>
                                        <div
                                            className={`inv-rounded-md inv-border inv-px-3 inv-py-2 inv-text-sm inv-font-medium ${
                                                authentic
                                                    ? "inv-border-success/40 inv-text-success"
                                                    : hashOnly
                                                      ? "inv-border-warning/40 inv-text-warning"
                                                      : "inv-border-danger/50 inv-text-danger"
                                            }`}
                                        >
                                            {authentic
                                                ? "Authentic. This record has not been tampered with, checked entirely in your browser."
                                                : hashOnly
                                                  ? "Hash verified. The content matches the sealed hash; the signature cannot be machine-checked in this browser."
                                                  : "Tampered. This record was changed after it was signed."}
                                        </div>
                                    </div>
                                );
                            })()}
                    </div>
                </div>
            </aside>
        </div>
    );
}

function ScrollButton({
    title,
    onClick,
    children,
}: {
    title: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-label={title}
            className={`inv-rounded inv-border inv-border-border inv-p-0.5 inv-text-foreground/50 hover:inv-bg-muted ${NO_RING}`}
        >
            {children}
        </button>
    );
}

function Step({ n, label, children }: { n: number; label: string; children: ReactNode }) {
    return (
        <div>
            <div className="inv-mb-0.5 inv-text-foreground/60">
                <span className="inv-font-medium inv-text-foreground/80">{n}.</span> {label}
            </div>
            <div className="inv-pl-4">{children}</div>
        </div>
    );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
    return (
        <div className="inv-grid inv-grid-cols-[110px_1fr] inv-gap-3">
            <span className="inv-text-foreground/50">{k}</span>
            <span className={`inv-break-all ${mono ? "inv-font-mono inv-text-[13px]" : ""}`}>{v}</span>
        </div>
    );
}
