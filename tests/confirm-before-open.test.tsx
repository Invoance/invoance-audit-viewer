// @vitest-environment jsdom
//
// 0.1.3: a ?token= link is single-use, and anything that renders the page on
// load (a mail scanner such as Safe Links, a link preview) used to burn it
// before the person arrived. With tokenFromUrl the viewer now shows an "Open
// audit log" button and exchanges only on the click. These cases pin that:
// nothing is exchanged on load, the click exchanges exactly once, a refresh
// reuses the stored session, the opt-out restores auto-exchange, and the
// getPortalToken callback path stays automatic.

import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogViewer from "../src/AuditLogViewer";
import type { AuditLogViewerProps } from "../src/types";
import { _resetExchangeCacheForTests } from "../src/portalClient";

function fakeJwt(intent: string): string {
    const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify({ intent, aud: "audit_portal" }))}.sig`;
}

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const SS_KEY = "invoance_portal_jwt";
const JWT = fakeJwt("audit_logs");

type Call = { url: string; auth: string | null };

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Stub fetch; `exchangeStatus` lets a case reject the link. */
function stubFetch(exchangeStatus = 200): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const headers = (init?.headers ?? {}) as Record<string, string>;
            calls.push({ url, auth: headers.Authorization ?? null });
            if (url.endsWith("/exchange")) {
                return exchangeStatus === 200
                    ? json({ token: JWT })
                    : json({ error: "invalid_token" }, exchangeStatus);
            }
            if (url.includes("/events")) return json({ events: [], next_cursor: null });
            return json({});
        }),
    );
    return calls;
}

const exchanges = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/exchange"));

let host: HTMLDivElement;
let root: Root;

async function mount(props: AuditLogViewerProps) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(
            <StrictMode>
                <AuditLogViewer baseUrl="http://api.test" {...props} />
            </StrictMode>,
        );
    });
    await settle();
}

async function unmount() {
    await act(async () => {
        root.unmount();
    });
    host.remove();
}

async function settle() {
    await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
    });
}

function openButton(): HTMLButtonElement | null {
    return (
        Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Open audit log") ??
        null
    );
}

describe("confirm before open (tokenFromUrl)", () => {
    beforeEach(() => {
        _resetExchangeCacheForTests();
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        sessionStorage.clear();
        window.history.replaceState({}, "", "/portal?keep=1&token=tok_click_123");
    });

    afterEach(async () => {
        if (host?.isConnected) await unmount();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("does not exchange on load; shows a labelled button and keeps the token", async () => {
        const calls = stubFetch();
        await mount({ tokenFromUrl: true, persistSession: true });

        expect(calls).toHaveLength(0);
        const btn = openButton();
        expect(btn).not.toBeNull();
        expect(btn!.type).toBe("button");
        const section = host.querySelector("section");
        const heading = host.querySelector("h1");
        expect(heading?.textContent).toBe("Audit log");
        expect(section?.getAttribute("aria-labelledby")).toBe(heading?.id);
        expect(window.location.search).toBe("?keep=1&token=tok_click_123");
        expect(sessionStorage.getItem(SS_KEY)).toBeNull();
    });

    it("a second load before the click still shows the button and exchanges nothing", async () => {
        const calls = stubFetch();
        await mount({ tokenFromUrl: true, persistSession: true });
        await unmount();
        await mount({ tokenFromUrl: true, persistSession: true });

        expect(calls).toHaveLength(0);
        expect(openButton()).not.toBeNull();
    });

    it("the click exchanges exactly once, strips only the token, stores and uses the session", async () => {
        const calls = stubFetch();
        await mount({ tokenFromUrl: true, persistSession: true });

        await act(async () => {
            openButton()!.click();
            openButton()?.click(); // a double click must not exchange twice
        });
        await settle();

        expect(exchanges(calls)).toHaveLength(1);
        expect(exchanges(calls)[0].url).toBe("http://api.test/v1/audit/portal/exchange");
        expect(window.location.search).toBe("?keep=1");
        expect(sessionStorage.getItem(SS_KEY)).toBe(JWT);
        expect(openButton()).toBeNull();
        const eventCalls = calls.filter((c) => c.url.includes("/events"));
        expect(eventCalls.length).toBeGreaterThan(0);
        expect(eventCalls[0].auth).toBe(`Bearer ${JWT}`);
    });

    it("a refresh after opening uses the stored session, with no button and no exchange", async () => {
        let calls = stubFetch();
        await mount({ tokenFromUrl: true, persistSession: true });
        await act(async () => {
            openButton()!.click();
        });
        await settle();
        expect(exchanges(calls)).toHaveLength(1);
        await unmount();

        // Reload: same URL (token already stripped), same sessionStorage.
        calls = stubFetch();
        await mount({ tokenFromUrl: true, persistSession: true });

        expect(openButton()).toBeNull();
        expect(exchanges(calls)).toHaveLength(0);
        const eventCalls = calls.filter((c) => c.url.includes("/events"));
        expect(eventCalls.length).toBeGreaterThan(0);
        expect(eventCalls[0].auth).toBe(`Bearer ${JWT}`);
    });

    it("a rejected link shows the existing error message after the click", async () => {
        const calls = stubFetch(401);
        await mount({ tokenFromUrl: true, persistSession: true });
        await act(async () => {
            openButton()!.click();
        });
        await settle();

        expect(exchanges(calls)).toHaveLength(1);
        expect(host.textContent).toContain("invalid, expired, or already used");
        expect(openButton()).toBeNull();
        expect(sessionStorage.getItem(SS_KEY)).toBeNull();
    });

    it("confirmBeforeOpen={false} restores the exchange on load", async () => {
        const calls = stubFetch();
        await mount({ tokenFromUrl: true, persistSession: true, confirmBeforeOpen: false });

        expect(openButton()).toBeNull();
        expect(exchanges(calls)).toHaveLength(1);
        expect(window.location.search).toBe("?keep=1");
        expect(sessionStorage.getItem(SS_KEY)).toBe(JWT);
    });

    it("the getPortalToken callback path stays automatic, with no button", async () => {
        window.history.replaceState({}, "", "/embed");
        const calls = stubFetch();
        const getPortalToken = vi.fn(async () => "tok_from_callback");
        await mount({ getPortalToken });

        expect(openButton()).toBeNull();
        expect(getPortalToken).toHaveBeenCalledTimes(1);
        expect(exchanges(calls)).toHaveLength(1);
        const eventCalls = calls.filter((c) => c.url.includes("/events"));
        expect(eventCalls[0].auth).toBe(`Bearer ${JWT}`);
    });

    it("tokenFromUrl with a callback but no ?token= goes straight to the callback", async () => {
        window.history.replaceState({}, "", "/embed");
        const calls = stubFetch();
        const getPortalToken = vi.fn(async () => "tok_from_callback");
        await mount({ tokenFromUrl: true, getPortalToken });

        expect(openButton()).toBeNull();
        expect(getPortalToken).toHaveBeenCalledTimes(1);
        expect(exchanges(calls)).toHaveLength(1);
    });
});
