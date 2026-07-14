// @vitest-environment jsdom
//
// Embed-plan B4 gate: React 18 StrictMode double-mounts effects in dev. The
// exchange endpoint consumes its one-time token server-side, so a double-mount
// must issue exactly ONE /exchange call; the module-level in-flight dedup in
// portalClient is what guarantees that.

import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogViewer from "../src/AuditLogViewer";
import { _resetExchangeCacheForTests } from "../src/portalClient";

function fakeJwt(intent: string): string {
    const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify({ intent, aud: "audit_portal" }))}.sig`;
}

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("StrictMode-safe exchange", () => {
    beforeEach(() => {
        _resetExchangeCacheForTests();
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        window.history.replaceState({}, "", "/embed?keep=1&token=tok_once_123");
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("double-mount issues exactly one /exchange call and strips only the token param", async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                calls.push(url);
                if (url.endsWith("/exchange")) {
                    return new Response(JSON.stringify({ token: fakeJwt("audit_logs") }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                if (url.includes("/events")) {
                    return new Response(JSON.stringify({ events: [], next_cursor: null }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                return new Response(JSON.stringify({}), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }),
        );

        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(
                <StrictMode>
                    <AuditLogViewer tokenFromUrl baseUrl="http://api.test" />
                </StrictMode>,
            );
        });
        // Let the exchange promise and the follow-up fetches settle.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });

        const exchangeCalls = calls.filter((u) => u.endsWith("/exchange"));
        expect(exchangeCalls).toHaveLength(1);
        expect(exchangeCalls[0]).toBe("http://api.test/v1/audit/portal/exchange");

        // Only the token param is stripped; the host page's params survive.
        expect(window.location.search).toBe("?keep=1");

        await act(async () => {
            root.unmount();
        });
        host.remove();
    });
});
