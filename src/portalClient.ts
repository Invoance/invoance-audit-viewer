// Fetch plumbing for the portal API.
//
// The exchange endpoint consumes its one-time token server-side, so it must
// never be called twice with the same token. React 18 StrictMode double-mounts
// effects in development; a module-level in-flight map keyed by token dedupes
// those into a single network call (the second caller awaits the first's
// promise). Successful exchanges stay cached for the life of the page: the
// token is burned, so re-exchanging it can only ever fail.

export const DEFAULT_BASE_URL = "https://api.invoance.com";

export function portalBase(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/v1/audit/portal`;
}

export class ExchangeError extends Error {
    /** True when the link itself was rejected (invalid, expired, or already
        used) as opposed to a network failure. */
    readonly linkRejected: boolean;

    constructor(message: string, linkRejected: boolean) {
        super(message);
        this.name = "ExchangeError";
        this.linkRejected = linkRejected;
    }
}

const inFlight = new Map<string, Promise<string>>();

/** Max automatic retries after a 429; the per-IP exchange limiter rejects
    BEFORE the token is consumed, so retrying the same token is safe. */
const MAX_429_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;

function retryWaitMs(res: Response): number {
    const header = Number(res.headers.get("retry-after"));
    const ms = Number.isFinite(header) && header >= 0 ? header * 1000 : 1000;
    return Math.min(ms, MAX_RETRY_WAIT_MS);
}

/** Exchange a one-time portal token for the org-scoped session JWT. */
export function exchangePortalToken(baseUrl: string, token: string): Promise<string> {
    const key = `${portalBase(baseUrl)}|${token}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const p = (async () => {
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
                res = await fetch(`${portalBase(baseUrl)}/exchange`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token }),
                });
            } catch {
                throw new ExchangeError("Could not reach the server. Please try again.", false);
            }
            // Rate-limited (e.g. many colleagues behind one NAT clicking links
            // in the same second). The link is NOT consumed by a 429, so wait
            // out Retry-After and try again; past the retry budget, say what
            // actually happened instead of blaming the link.
            if (res.status === 429) {
                if (attempt < MAX_429_RETRIES) {
                    await new Promise((r) => setTimeout(r, retryWaitMs(res)));
                    continue;
                }
                throw new ExchangeError(
                    "The server is busy right now. Please try again in a moment; this link is still valid.",
                    false,
                );
            }
            const b = await res.json().catch(() => null);
            if (!res.ok || !b?.token) {
                throw new ExchangeError(
                    "This portal link is invalid, expired, or already used. Ask for a fresh link.",
                    true,
                );
            }
            return b.token as string;
        }
    })();

    inFlight.set(key, p);
    // A network failure may be retried with the same token; a rejected link is
    // also cleared, the retry will just surface the same server answer.
    p.catch(() => inFlight.delete(key));
    return p;
}

/** Test-only: forget in-flight/settled exchanges so cases are independent. */
export function _resetExchangeCacheForTests(): void {
    inFlight.clear();
}
