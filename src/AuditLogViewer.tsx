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
// - A ?token= link waits for an "Open audit log" click before the exchange
//   (confirmBeforeOpen): links are single-use, and anything that renders the
//   page on load, such as a mail scanner, would otherwise burn it.
// - One filter bar of chips (FilterBar.tsx, mapping in filters.ts) drives the
//   list query; the detail view (EventDetail.tsx) replaces the list in place.
// - The open event, its section, the filters and the page live in the URL
//   (urlState.ts) unless syncUrl is false, so a reload lands in the same view.

import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
    type RefObject,
} from "react";
import EventDetail from "./EventDetail";
import FilterBar, { type FacetsSupport } from "./FilterBar";
import { actorPrimary, fmtClock, fmtDate, targetName } from "./format";
import { Box, Check, ChevronDown, ChevronRight } from "./icons";
import { chipsToParams, type Chip } from "./filters";
import { DEFAULT_BASE_URL, exchangePortalToken, portalBase } from "./portalClient";
import StreamConfig from "./StreamConfig";
import { NO_RING } from "./ui";
import { readUrlState, urlFor, type UrlState } from "./urlState";
import type {
    AuditEvent,
    AuditLogViewerProps,
    AuthedFetch,
    Brand,
} from "./types";

const SS_KEY = "invoance_portal_jwt";
const PAGE_SIZES = [25, 50, 100];
// Actor | Event | Date and time | chevron
const ROW_COLS = "inv-grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,170px)_16px]";

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
    confirmBeforeOpen = true,
    persistSession = false,
    baseUrl = DEFAULT_BASE_URL,
    pageSize: initialPageSize = 25,
    autoRefresh = true,
    className,
    theme,
    onSessionExpired,
    syncUrl = true,
    urlParamPrefix = "",
}: AuditLogViewerProps) {
    // Where the reader was, read once from the URL (see urlState.ts).
    const initialUrl = useRef<UrlState | null>(null);
    if (initialUrl.current === null) {
        initialUrl.current =
            syncUrl && typeof window !== "undefined"
                ? readUrlState(window.location.search, urlParamPrefix)
                : { chips: [], event: null, section: null, cursor: null, page: 1, rows: null };
    }
    const fromUrl = initialUrl.current;

    const [jwt, setJwt] = useState<string | null>(null);
    const [status, setStatus] = useState<"loading" | "confirm" | "ready" | "error">("loading");
    // The URL token waiting for the visitor's click (confirmBeforeOpen).
    const [pendingToken, setPendingToken] = useState<string | null>(null);
    const openTitleId = useId();
    const [error, setError] = useState<string>("");
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [loading, setLoading] = useState(false);

    // paging: keyset cursor stack for Prev/Next
    const [pageSize, setPageSize] = useState<number>(fromUrl.rows ?? initialPageSize);
    // A page restored from the URL knows only its own cursor; the pages
    // between it and page 1 stay unknown (Prev from there goes to page 1).
    const [pageCursors, setPageCursors] = useState<(string | null | undefined)[]>(() => {
        if (fromUrl.page <= 1 || !fromUrl.cursor) return [null];
        const c: (string | null | undefined)[] = new Array(fromUrl.page).fill(undefined);
        c[0] = null;
        c[fromUrl.page - 1] = fromUrl.cursor;
        return c;
    });
    const [pageIndex, setPageIndex] = useState(fromUrl.cursor ? fromUrl.page - 1 : 0);
    const [nextCursor, setNextCursor] = useState<string | null>(null);

    // filters: one chip per active filter (see filters.ts for the mapping)
    const [chips, setChips] = useState<Chip[]>(fromUrl.chips);
    const [facetsSupport, setFacetsSupport] = useState<FacetsSupport>("unknown");

    // The event open in the detail view; the list (rows, chips, page) stays
    // in state underneath so going back restores it exactly.
    const [selected, setSelected] = useState<AuditEvent | null>(null);
    // The highlighted section of the open event (also kept in the URL).
    const [section, setSection] = useState<string | null>(fromUrl.section);
    // An event id from the URL still being fetched; the URL keeps it meanwhile.
    const [restoringEvent, setRestoringEvent] = useState<string | null>(fromUrl.event);
    const lastOpenedId = useRef<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
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

    // Exchange a one-time URL token, strip it, and start the session.
    const openUrlToken = useCallback(
        async (token: string, isCancelled: () => boolean = () => false) => {
            try {
                const j = await exchangePortalToken(baseUrl, token);
                stripTokenFromUrl();
                if (!isCancelled()) storeJwt(j);
            } catch (e) {
                if (!isCancelled()) {
                    setStatus("error");
                    setError(e instanceof Error ? e.message : "Could not start the session.");
                }
            }
        },
        [baseUrl, storeJwt],
    );

    // 1) Obtain the portal JWT. Order: a fresh ?token= (when tokenFromUrl)
    //    always wins, then a stored session (when persistSession), then the
    //    getPortalToken callback. With confirmBeforeOpen the URL token waits
    //    for the click instead of being exchanged here.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (tokenFromUrl) {
                const token = new URLSearchParams(window.location.search).get("token");
                if (token) {
                    if (confirmBeforeOpen) {
                        setPendingToken(token);
                        setStatus("confirm");
                        return;
                    }
                    await openUrlToken(token, () => cancelled);
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
            const qs = new URLSearchParams(chipsToParams(chips));
            qs.set("limit", String(limit));
            if (cursor) qs.set("cursor", cursor);
            return qs;
        },
        [chips],
    );

    // The date chip's range, for scoping the facets suggestions.
    const dateParams = useMemo(() => chipsToParams(chips.filter((c) => c.field === "date")), [chips]);

    // The URL for the current state; the write effect below keeps it in step.
    const currentUrl = (event: string | null, sec: string | null) =>
        urlFor(
            window.location.href,
            {
                chips,
                event,
                section: sec,
                cursor: pageCursors[pageIndex] ?? null,
                page: pageIndex + 1,
                rows: pageSize,
            },
            urlParamPrefix,
        );

    function openEvent(e: AuditEvent) {
        lastOpenedId.current = e.id;
        setSelected(e);
        setSection(null);
        // Opening an event is a history step, so the browser's Back returns
        // to the list; filters and paging only replace the current entry.
        if (syncUrl) window.history.pushState({ invEvent: e.id }, "", currentUrl(e.id, null));
        // An embed may sit below the fold; bring the detail's top into view.
        const top = rootRef.current?.getBoundingClientRect().top ?? 0;
        if (top < 0) rootRef.current?.scrollIntoView?.({ block: "start" });
    }

    function closeEvent() {
        // Undo our own history step when it is the current one; popstate
        // then closes the view. Otherwise (opened from a reload) close here.
        if (syncUrl && selected && window.history.state?.invEvent === selected.id) {
            window.history.back();
            return;
        }
        setSelected(null);
        setSection(null);
    }

    // An event named in the URL: show it from the loaded rows or fetch it.
    const showEventById = useCallback(
        async (id: string) => {
            const known = events.find((e) => e.id === id);
            if (known) {
                lastOpenedId.current = id;
                setSelected(known);
                return;
            }
            try {
                const res = await authedFetch(`/events/${encodeURIComponent(id)}`);
                const b = res && res.ok ? await res.json().catch(() => null) : null;
                if (b && b.id === id) {
                    lastOpenedId.current = id;
                    setSelected(b as AuditEvent);
                } else {
                    setSelected(null);
                    setSection(null);
                }
            } catch {
                setSelected(null);
            }
        },
        [events, authedFetch],
    );

    useEffect(() => {
        if (!jwt || isStreams || !restoringEvent) return;
        let cancelled = false;
        void showEventById(restoringEvent).finally(() => {
            if (!cancelled) setRestoringEvent(null);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jwt, isStreams, restoringEvent]);

    // Browser Back/Forward between the list and an event.
    useEffect(() => {
        if (!syncUrl) return;
        const onPop = () => {
            const st = readUrlState(window.location.search, urlParamPrefix);
            setSection(st.section);
            if (!st.event) setSelected(null);
            else if (st.event !== selected?.id) setRestoringEvent(st.event);
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, [syncUrl, urlParamPrefix, selected]);

    // Keep the URL in step with the state, without adding history entries.
    useEffect(() => {
        if (!syncUrl || !jwt || isStreams || restoringEvent) return;
        const next = currentUrl(selected?.id ?? null, selected ? section : null);
        const now = window.location.pathname + window.location.search + window.location.hash;
        if (next !== now) window.history.replaceState(window.history.state, "", next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncUrl, jwt, isStreams, restoringEvent, chips, pageIndex, pageCursors, pageSize, selected, section]);

    // Back from the detail view: return focus to the row that was opened.
    useEffect(() => {
        if (selected || !lastOpenedId.current) return;
        const id = lastOpenedId.current;
        Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [])
            .find((el) => el.dataset.eventId === id)
            ?.focus();
    }, [selected]);

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

    // Load the current page once the session exists, and go back to page 1
    // whenever the filters or the page size change. The first load keeps a
    // page restored from the URL.
    const filterKey = JSON.stringify([chips, pageSize]);
    const lastFilterKey = useRef(filterKey);
    useEffect(() => {
        if (!jwt) return;
        if (isStreams) {
            // The streams screen loads its own data; nothing to fetch here.
            setStatus("ready");
            return;
        }
        if (lastFilterKey.current !== filterKey) {
            lastFilterKey.current = filterKey;
            setPageCursors([null]);
            setPageIndex(0);
            fetchPage(null);
            return;
        }
        fetchPage(pageCursors[pageIndex] ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Unknown cursor (a page restored from the URL): go to page 1.
        const idx = pageCursors[pageIndex - 1] === undefined ? 0 : pageIndex - 1;
        setPageIndex(idx);
        fetchPage(pageCursors[idx] ?? null);
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
            ref={rootRef}
            className={`inv-root inv-mx-auto inv-max-w-6xl inv-bg-background inv-px-6 inv-py-8 inv-text-foreground${className ? ` ${className}` : ""}`}
            style={themeStyle}
        >
            {children}
        </div>
    );

    if (status === "loading") return root(<Centered>Loading your audit log…</Centered>);
    if (status === "confirm" && pendingToken) {
        return root(
            <section
                aria-labelledby={openTitleId}
                className="inv-mx-auto inv-flex inv-max-w-md inv-flex-col inv-items-center inv-gap-3 inv-py-16 inv-text-center"
            >
                <h1 id={openTitleId} className="inv-text-xl inv-font-semibold inv-tracking-tight">
                    Audit log
                </h1>
                <p className="inv-text-sm inv-text-foreground/70">
                    This link opens a read-only view of the audit log. It works once, so open it when you are
                    ready.
                </p>
                <button
                    type="button"
                    onClick={() => {
                        setStatus("loading");
                        void openUrlToken(pendingToken);
                    }}
                    className="inv-mt-2 inv-border inv-border-foreground inv-bg-foreground inv-px-4 inv-py-2 inv-text-sm inv-font-medium inv-text-background hover:inv-bg-foreground/90 focus:inv-outline-none focus-visible:inv-outline focus-visible:inv-outline-2 focus-visible:inv-outline-offset-2 focus-visible:inv-outline-foreground/40"
                >
                    Open audit log
                </button>
            </section>,
        );
    }
    if (status === "error") return root(<Centered>{error}</Centered>);

    return root(
        <>
            <header className="inv-mb-6 inv-flex inv-items-center inv-justify-between inv-gap-4">
                <div>
                    <h1 className="inv-text-xl inv-font-semibold inv-tracking-tight">{headerTitle}</h1>
                    <p className="inv-mt-1 inv-text-sm inv-text-foreground/60">{headerSubtitle}</p>
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
            ) : selected ? (
                <EventDetail
                    event={selected}
                    onBack={closeEvent}
                    section={section}
                    onSection={setSection}
                />
            ) : (
                <>
                    <div className="inv-mb-4 inv-flex inv-flex-wrap inv-items-start inv-gap-3">
                        <FilterBar
                            chips={chips}
                            onChange={setChips}
                            fetcher={authedFetch}
                            events={events}
                            range={dateParams}
                            facetsSupport={facetsSupport}
                            onFacetsSupport={setFacetsSupport}
                        />
                        <ExportMenu
                            exporting={exporting}
                            disabled={exporting !== null || loading}
                            onExport={exportAs}
                        />
                    </div>

                    <div className="inv-border inv-border-border">
                        <div
                            className={`inv-grid ${ROW_COLS} inv-gap-3 inv-border-b inv-border-border inv-bg-muted/40 inv-px-4 inv-py-2 inv-text-xs inv-font-medium inv-text-foreground/60`}
                        >
                            <span>Actor</span>
                            <span>Event</span>
                            <span>Date and time</span>
                            <span />
                        </div>

                        {events.length === 0 ? (
                            <div className="inv-px-4 inv-py-8 inv-text-sm inv-text-foreground/60">
                                {chips.length ? "No events match these filters." : "No events yet."}
                            </div>
                        ) : (
                            <div className="inv-divide-y inv-divide-border">
                                {events.map((e) => {
                                    const first = e.targets?.[0];
                                    const more = (e.targets?.length ?? 0) - 1;
                                    return (
                                        <button
                                            key={e.id}
                                            type="button"
                                            data-event-id={e.id}
                                            onClick={() => openEvent(e)}
                                            className={`inv-grid inv-w-full ${ROW_COLS} inv-items-center inv-gap-3 inv-px-4 inv-py-3 inv-text-left inv-text-sm hover:inv-bg-muted/40 focus:inv-outline-none focus-visible:inv-bg-muted/60`}
                                        >
                                            <span className="inv-min-w-0">
                                                <span className="inv-block inv-truncate">{actorPrimary(e.actor)}</span>
                                                <span className="inv-block inv-truncate inv-text-xs inv-text-foreground/50">
                                                    {e.actor?.type || "\u00a0"}
                                                </span>
                                            </span>
                                            <span className="inv-min-w-0">
                                                <span className="inv-block inv-truncate inv-font-mono inv-text-[13px]">
                                                    {e.action}
                                                </span>
                                                <span className="inv-flex inv-min-w-0 inv-items-center inv-gap-1 inv-text-xs inv-text-foreground/50">
                                                    {first ? (
                                                        <>
                                                            <Box className="inv-h-3 inv-w-3 inv-shrink-0" />
                                                            <span className="inv-truncate">{targetName(first)}</span>
                                                            {more > 0 && (
                                                                <span className="inv-shrink-0 inv-bg-muted inv-px-1 inv-text-[10px] inv-text-foreground/60">
                                                                    +{more}
                                                                </span>
                                                            )}
                                                        </>
                                                    ) : (
                                                        "\u00a0"
                                                    )}
                                                </span>
                                            </span>
                                            <span className="inv-min-w-0" title={e.occurred_at}>
                                                <span className="inv-block inv-truncate inv-text-foreground/80">
                                                    {fmtDate(e.occurred_at)}
                                                </span>
                                                <span className="inv-block inv-truncate inv-text-xs inv-tabular-nums inv-text-foreground/50">
                                                    {fmtClock(e.occurred_at)}
                                                </span>
                                            </span>
                                            <ChevronRight className="inv-h-4 inv-w-4 inv-text-foreground/30" />
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {/* Pager: the card's footer. Rows is hidden while everything
                            fits on one page at the smallest size. */}
                        <div className="inv-flex inv-min-h-[52px] inv-items-center inv-justify-between inv-gap-3 inv-border-t inv-border-border inv-px-4 inv-py-2.5">
                            {pageIndex === 0 && !nextCursor && events.length <= PAGE_SIZES[0] ? (
                                <span className="inv-text-sm inv-text-foreground/50">
                                    {events.length === 1 ? "1 event" : `${events.length} events`}
                                </span>
                            ) : (
                                <label className="inv-flex inv-items-center inv-gap-2 inv-text-sm inv-text-foreground/60">
                                    Rows
                                    <PageSizeDropdown value={pageSize} onChange={(n) => setPageSize(n)} />
                                </label>
                            )}
                            <div className="inv-flex inv-items-center inv-gap-3 inv-text-sm">
                                {autoRefresh && pageIndex === 0 && (
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
                                    className={`inv-border inv-border-border inv-px-3 inv-py-1.5 hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
                                >
                                    Prev
                                </button>
                                <button
                                    onClick={goNext}
                                    disabled={!nextCursor || loading}
                                    className={`inv-border inv-border-border inv-px-3 inv-py-1.5 hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
                                >
                                    Next
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </>,
    );
}

/* Menus open below their trigger when they fit there, and above when they do
   not and there is more room above. Measured before paint, so no flicker. */
function useOpensUp(open: boolean, anchor: RefObject<HTMLElement>, menu: RefObject<HTMLElement>): boolean {
    const [up, setUp] = useState(false);
    useLayoutEffect(() => {
        if (!open || !anchor.current) {
            setUp(false);
            return;
        }
        const r = anchor.current.getBoundingClientRect();
        const h = menu.current?.offsetHeight ?? 0;
        const below = window.innerHeight - r.bottom;
        setUp(below < h + 8 && r.top > below);
    }, [open, anchor, menu]);
    return up;
}

/* Custom page-size dropdown: themed, no focus ring, closes on outside-click or
   Escape. Opens downward, or upward when there is no room below. */
function PageSizeDropdown({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const up = useOpensUp(open, ref, menuRef);

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
                className={`inv-flex inv-h-8 inv-min-w-[72px] inv-items-center inv-justify-between inv-gap-2 inv-border inv-border-border inv-bg-background inv-px-2.5 inv-text-sm inv-transition hover:inv-border-foreground/30 ${NO_RING}`}
            >
                <span>{value}</span>
                <ChevronDown
                    className={`inv-h-3.5 inv-w-3.5 inv-shrink-0 inv-text-foreground/50 inv-transition-transform ${open ? "inv-rotate-180" : ""}`}
                />
            </button>

            {open && (
                <div
                    ref={menuRef}
                    className={`inv-absolute inv-left-0 inv-z-50 inv-min-w-[72px] ${up ? "inv-bottom-full inv-mb-1" : "inv-top-full inv-mt-1"} inv-border inv-border-border inv-bg-popover inv-text-popover-foreground inv-shadow-lg`}
                >
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
    const menuRef = useRef<HTMLDivElement>(null);
    const up = useOpensUp(open, ref, menuRef);

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
                className={`inv-flex inv-items-center inv-gap-2 inv-border inv-border-border inv-px-3 inv-py-1.5 inv-text-sm hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
            >
                {exporting !== null ? "Exporting…" : "Export"}
                <ChevronDown
                    className={`inv-h-3.5 inv-w-3.5 inv-shrink-0 inv-text-foreground/50 inv-transition-transform ${open ? "inv-rotate-180" : ""}`}
                />
            </button>

            {open && (
                <div
                    ref={menuRef}
                    className={`inv-absolute inv-right-0 inv-z-50 inv-min-w-[140px] ${up ? "inv-bottom-full inv-mb-1" : "inv-top-full inv-mt-1"} inv-border inv-border-border inv-bg-popover inv-text-popover-foreground inv-shadow-lg`}
                >
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
