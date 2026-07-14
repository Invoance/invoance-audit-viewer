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

/** Exchange a one-time portal token for the org-scoped session JWT. */
export function exchangePortalToken(baseUrl: string, token: string): Promise<string> {
    const key = `${portalBase(baseUrl)}|${token}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const p = (async () => {
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
        const b = await res.json().catch(() => null);
        if (!res.ok || !b?.token) {
            throw new ExchangeError(
                "This portal link is invalid, expired, or already used. Ask for a fresh link.",
                true,
            );
        }
        return b.token as string;
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
