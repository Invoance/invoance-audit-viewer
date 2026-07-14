// 0.1.2: a 429 from the per-IP exchange limiter must be retried (the token is
// not consumed by a rate-limit rejection), and past the retry budget the error
// must say "busy", not the misleading "invalid or already used".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeError, exchangePortalToken, _resetExchangeCacheForTests } from "../src/portalClient";

function res429() {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: 1 }), {
        status: 429,
        headers: { "Retry-After": "0", "Content-Type": "application/json" },
    });
}
function resOk() {
    return new Response(JSON.stringify({ token: "jwt.ok.sig" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

describe("exchange 429 retry", () => {
    beforeEach(() => _resetExchangeCacheForTests());
    afterEach(() => vi.restoreAllMocks());

    it("retries after a 429 and succeeds without burning the link", async () => {
        const fetchMock = vi.fn(async () => res429());
        fetchMock.mockResolvedValueOnce(res429()).mockResolvedValueOnce(resOk());
        vi.stubGlobal("fetch", fetchMock);

        const jwt = await exchangePortalToken("http://api.test", "tok_retry_once");
        expect(jwt).toBe("jwt.ok.sig");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives an honest busy message after the retry budget, not 'invalid link'", async () => {
        const fetchMock = vi.fn(async () => res429());
        vi.stubGlobal("fetch", fetchMock);

        const err = await exchangePortalToken("http://api.test", "tok_always_429").catch((e) => e);
        expect(err).toBeInstanceOf(ExchangeError);
        expect((err as ExchangeError).linkRejected).toBe(false);
        expect((err as ExchangeError).message).toMatch(/busy/i);
        expect((err as ExchangeError).message).not.toMatch(/invalid/i);
        // initial attempt + 2 retries
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("a genuinely rejected link still reports linkRejected", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 })),
        );
        const err = await exchangePortalToken("http://api.test", "tok_burned").catch((e) => e);
        expect(err).toBeInstanceOf(ExchangeError);
        expect((err as ExchangeError).linkRejected).toBe(true);
    });
});
