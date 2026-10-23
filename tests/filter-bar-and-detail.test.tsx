// @vitest-environment jsdom
//
// 0.2.0 redesign, rendered: the filter bar's facets call and its 404
// fallback, chips driving the list query, the table rows, and the in-place
// detail view with its breadcrumb back to the list.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogViewer from "../src/AuditLogViewer";
import { _resetExchangeCacheForTests } from "../src/portalClient";
import type { AuditEvent } from "../src/types";

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function fakeJwt(intent: string): string {
    const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify({ intent, aud: "audit_portal" }))}.sig`;
}

const EVENTS: AuditEvent[] = [
    {
        id: "aevt_one",
        seq: 2,
        occurred_at: "2026-10-23T10:40:15Z",
        ingested_at: "2026-10-23T10:40:16Z",
        action: "lead.updated",
        actor: { id: "user_maya", name: "Maya Collins", type: "user" },
        targets: [
            { id: "lead_8841", name: "Lead 8841", type: "crm_lead" },
            { id: "user_sam", name: "Sam Okafor", type: "user" },
        ],
        context: { location: "203.0.113.7", user_agent: "Mozilla/5.0 test" },
        metadata: null,
        payload_hash: "abc123",
        signature: "sig456",
        signing_public_key: "pk",
    },
    {
        id: "aevt_two",
        seq: 1,
        occurred_at: "2026-10-22T09:00:00Z",
        ingested_at: "2026-10-22T09:00:01Z",
        action: "list.exported",
        actor: { id: "user_luis", name: "Luis Ortega", type: "user" },
        targets: [{ id: "list_q4", name: "Q4 list", type: "list" }],
        context: null,
        metadata: null,
        payload_hash: "def",
        signature: "ghi",
        signing_public_key: "pk",
    },
];

type FacetsMode = "ok" | "404" | "throw";

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(facets: FacetsMode): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            calls.push(url);
            if (url.includes("/facets")) {
                if (facets === "throw") throw new TypeError("Failed to fetch");
                if (facets === "404") return json({ error: "not_found" }, 404);
                const field = new URL(url).searchParams.get("field");
                const values =
                    field === "actor_name"
                        ? [{ value: "Maya Collins", label: null, count: 9 }]
                        : field === "target_type"
                          ? [{ value: "crm_lead", label: null, count: 4 }]
                          : [
                                { value: "document.deleted", label: null, count: 12 },
                                { value: "user.signed_in", label: null, count: 3 },
                            ];
                return json({ field, values });
            }
            const one = /\/events\/([^/?]+)$/.exec(url);
            if (one) {
                const e = EVENTS.find((x) => x.id === decodeURIComponent(one[1]));
                return e ? json(e) : json({ error: "not_found" }, 404);
            }
            if (url.includes("/events")) return json({ events: EVENTS, next_cursor: null });
            if (url.endsWith("/org")) return json({ issuer: { name: null }, org: { name: "Acme" } });
            return json({});
        }),
    );
    return calls;
}

const eventCalls = (calls: string[]) => calls.filter((u) => u.includes("/events?"));
const facetCalls = (calls: string[]) => calls.filter((u) => u.includes("/facets?"));
const lastEventsParams = (calls: string[]) => new URL(eventCalls(calls).slice(-1)[0]).searchParams;

async function mount(props: { syncUrl?: boolean } = {}) {
    render(<AuditLogViewer persistSession autoRefresh={false} baseUrl="http://api.test" {...props} />);
    await screen.findByText("lead.updated");
}

async function click(el: Element) {
    await act(async () => {
        fireEvent.click(el);
    });
}

async function openField(label: string) {
    await click(screen.getByRole("button", { name: /Filter events|Add filter/ }));
    const item = await screen.findByRole("button", { name: label });
    await click(item);
}

describe("filter bar", () => {
    beforeEach(() => {
        _resetExchangeCacheForTests();
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        sessionStorage.clear();
        sessionStorage.setItem("invoance_portal_jwt", fakeJwt("audit_logs"));
        window.history.replaceState({}, "", "/portal");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("renders rows: actor over type, action over first target with +N, date over clock", async () => {
        stubFetch("ok");
        await mount();
        const row = screen.getByText("lead.updated").closest("button")!;
        const r = within(row);
        expect(r.getByText("Maya Collins")).toBeTruthy();
        expect(r.getByText("user")).toBeTruthy();
        expect(r.getByText("Lead 8841")).toBeTruthy();
        expect(r.getByText("+1")).toBeTruthy();
        const date = new Date(EVENTS[0].occurred_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
        });
        expect(r.getByText(date)).toBeTruthy();
    });

    it("loads values from the facets endpoint and a picked value becomes a chip and a query param", async () => {
        const calls = stubFetch("ok");
        await mount();
        await openField("Action");

        await screen.findByText("document.deleted");
        const valuesCall = facetCalls(calls).find((u) => u.includes("limit=20"))!;
        const qs = new URL(valuesCall).searchParams;
        expect(qs.get("field")).toBe("action");
        expect(qs.get("occurred_after")).toBeNull();

        await click(screen.getByText("document.deleted").closest("button")!);
        expect(screen.getByText("action: document.deleted")).toBeTruthy();
        await waitFor(() => expect(lastEventsParams(calls).get("actions")).toBe("document.deleted"));

        // A second action widens (ANY of them) rather than narrowing.
        await openField("Action");
        await click((await screen.findByText("user.signed_in")).closest("button")!);
        await waitFor(() =>
            expect(lastEventsParams(calls).get("actions")).toBe("document.deleted,user.signed_in"),
        );
    });

    it("does not suggest a value that is already a filter", async () => {
        const calls = stubFetch("ok");
        await mount();
        await openField("Action");
        await click((await screen.findByText("document.deleted")).closest("button")!);
        await waitFor(() => expect(lastEventsParams(calls).get("actions")).toBe("document.deleted"));

        await openField("Action");
        const group = await screen.findByRole("group", { name: "Action values" });
        await waitFor(() => expect(within(group).getByText("user.signed_in")).toBeTruthy());
        expect(within(group).queryByText("document.deleted")).toBeNull();

        // Typing it shows that it is already there, with no "Filter by" offer.
        const input = screen.getByRole("textbox", { name: "Search actions" });
        await act(async () => {
            fireEvent.change(input, { target: { value: "document.deleted" } });
        });
        await waitFor(() => expect(within(group).getByText(/is already a filter/)).toBeTruthy());
        expect(within(group).queryByText(/Filter by/)).toBeNull();

        // With the last value taken, the picker says there is nothing left.
        await act(async () => {
            fireEvent.change(input, { target: { value: "" } });
        });
        await click((await within(group).findByText("user.signed_in")).closest("button")!);
        await openField("Action");
        expect(await screen.findByText("No other actions to add.")).toBeTruthy();
    });

        it("passes the typed prefix and the date chip's range to facets", async () => {
        const calls = stubFetch("ok");
        await mount();
        await openField("Date");
        await click(screen.getByRole("button", { name: "Last 30 days" }));
        expect(screen.getByText("date: Last 30 days")).toBeTruthy();
        await waitFor(() => expect(lastEventsParams(calls).get("occurred_after")).toBeTruthy());
        expect(lastEventsParams(calls).get("occurred_before")).toBeNull();

        await openField("Actor name");
        const input = await screen.findByRole("textbox", { name: "Search actor names" });
        await act(async () => {
            fireEvent.change(input, { target: { value: "Ma" } });
        });
        await waitFor(() => expect(facetCalls(calls).some((u) => u.includes("q=Ma"))).toBe(true));
        const qs = new URL(facetCalls(calls).find((u) => u.includes("q=Ma"))!).searchParams;
        expect(qs.get("field")).toBe("actor_name");
        expect(qs.get("occurred_after")).toBeTruthy();

        const values = await screen.findByRole("group", { name: "Actor name values" });
        await click((await within(values).findByText("Maya Collins")).closest("button")!);
        await waitFor(() => expect(lastEventsParams(calls).get("actor_name")).toBe("Maya Collins"));
    });

    it("target type maps to target_type", async () => {
        const calls = stubFetch("ok");
        await mount();
        await openField("Target");
        await click((await screen.findByText("crm_lead")).closest("button")!);
        expect(screen.getByText("target: crm_lead")).toBeTruthy();
        await waitFor(() => expect(lastEventsParams(calls).get("target_type")).toBe("crm_lead"));
    });

    it("a custom range sends both ends", async () => {
        const calls = stubFetch("ok");
        await mount();
        await openField("Date");
        await click(screen.getByRole("button", { name: /Custom range/ }));
        await act(async () => {
            fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
            fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-03" } });
        });
        await click(screen.getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(lastEventsParams(calls).get("occurred_before")).toBeTruthy());
        expect(lastEventsParams(calls).get("occurred_after")).toBe(new Date(2026, 9, 1).toISOString());
    });

    it.each(["404", "throw"] as const)(
        "facets %s: hides actor name and target, suggests from loaded rows",
        async (mode) => {
            const calls = stubFetch(mode);
            await mount();
            await click(screen.getByRole("button", { name: "Filter events" }));
            // The probe answers, then the field list drops the newer-API fields.
            await waitFor(() => expect(screen.queryByRole("button", { name: "Actor name" })).toBeNull());
            expect(screen.queryByRole("button", { name: "Target" })).toBeNull();
            expect(screen.getByRole("button", { name: "Actor id" })).toBeTruthy();
            expect(screen.getByRole("button", { name: "Target id" })).toBeTruthy();

            await click(screen.getByRole("button", { name: "Action" }));
            const group = await screen.findByRole("group", { name: "Action values" });
            await waitFor(() => expect(within(group).getByText("lead.updated")).toBeTruthy());
            expect(within(group).getByText("list.exported")).toBeTruthy();
            expect(facetCalls(calls).length).toBeGreaterThan(0);

            await click(within(group).getByText("list.exported").closest("button")!);
            await waitFor(() => expect(lastEventsParams(calls).get("actions")).toBe("list.exported"));
        },
    );

    it("removes one chip, then clears all", async () => {
        const calls = stubFetch("ok");
        await mount();
        await openField("Action");
        await click((await screen.findByText("document.deleted")).closest("button")!);
        await openField("Date");
        await click(screen.getByRole("button", { name: "Today" }));

        await click(screen.getByRole("button", { name: "Remove filter action: document.deleted" }));
        expect(screen.queryByText("action: document.deleted")).toBeNull();
        await waitFor(() => expect(lastEventsParams(calls).get("actions")).toBeNull());
        expect(lastEventsParams(calls).get("occurred_after")).toBeTruthy();

        await click(screen.getByRole("button", { name: "Clear all" }));
        expect(screen.queryByText("date: Today")).toBeNull();
        await waitFor(() => expect(lastEventsParams(calls).get("occurred_after")).toBeNull());
    });
});

describe("detail view", () => {
    beforeEach(() => {
        _resetExchangeCacheForTests();
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        sessionStorage.clear();
        sessionStorage.setItem("invoance_portal_jwt", fakeJwt("audit_logs"));
        window.history.replaceState({}, "", "/embed?keep=1");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("opens in place with facts, the signed record and the verify block", async () => {
        stubFetch("ok");
        await mount();
        await click(screen.getByText("lead.updated").closest("button")!);

        const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(within(crumb).getByRole("button", { name: "Audit log" })).toBeTruthy();
        expect(within(crumb).getByText("aevt_one")).toBeTruthy();
        expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();

        expect(screen.getByRole("button", { name: /2 targets/ })).toBeTruthy();
        expect(screen.getByText("Lead 8841, Sam Okafor")).toBeTruthy();
        expect(screen.getByText("203.0.113.7")).toBeTruthy();
        expect(screen.getByText("Mozilla/5.0 test")).toBeTruthy();

        const record = screen.getByRole("textbox", { name: "Signed record as JSON" }) as HTMLTextAreaElement;
        expect(JSON.parse(record.value).id).toBe("aevt_one");
        const verify = screen.getByRole("region", { name: "Signature verification" });
        expect(within(verify).getByText("abc123")).toBeTruthy();
        expect(within(verify).getByText("sig456")).toBeTruthy();
        expect(within(verify).getByRole("button", { name: "Verify signature" })).toBeTruthy();

        // The host page's own params survive; the event joins them.
        expect(window.location.pathname + window.location.search).toBe("/embed?keep=1&event=aevt_one");
        expect(document.activeElement?.tagName).toBe("H2");
    });

    it("syncUrl={false} leaves the page URL alone", async () => {
        stubFetch("ok");
        await mount({ syncUrl: false });
        await openField("Action");
        await click((await screen.findByText("document.deleted")).closest("button")!);
        await click(screen.getByText("lead.updated").closest("button")!);
        expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
        expect(window.location.pathname + window.location.search).toBe("/embed?keep=1");
        await click(screen.getByRole("button", { name: "Audit log" }));
        expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    });

    it("the breadcrumb returns to the list with filters and rows kept, focus on the opened row", async () => {
        const calls = stubFetch("ok");
        await mount();
        await openField("Action");
        await click((await screen.findByText("document.deleted")).closest("button")!);
        await waitFor(() => expect(lastEventsParams(calls).get("actions")).toBe("document.deleted"));
        const before = eventCalls(calls).length;

        await click(screen.getByText("lead.updated").closest("button")!);
        await click(screen.getByRole("button", { name: "Audit log" }));

        // Back undoes the history step the open added, through popstate.
        await waitFor(() => expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull());
        expect(screen.getByText("action: document.deleted")).toBeTruthy();
        expect(window.location.search).toBe("?keep=1&action=document.deleted");
        expect(screen.getByText("list.exported")).toBeTruthy();
        expect(eventCalls(calls).length).toBe(before);
        expect((document.activeElement as HTMLElement).dataset.eventId).toBe("aevt_one");
    });

    it("a section click highlights its lines in the record, and a second click clears it", async () => {
        stubFetch("ok");
        await mount();
        await click(screen.getByText("lead.updated").closest("button")!);

        const highlighted = () =>
            Array.from(document.querySelectorAll("[data-line][data-highlighted]")).map((el) => el.textContent ?? "");
        expect(highlighted()).toEqual([]);

        const actor = screen.getByRole("button", { name: /Maya Collins/ });
        await click(actor);
        expect(actor.getAttribute("aria-pressed")).toBe("true");
        const lines = highlighted();
        expect(lines[0]).toMatch(/^ {2}"actor": \{/);
        expect(lines.join("\n")).toContain('"name": "Maya Collins"');
        expect(lines.join("\n")).not.toContain('"action"');

        const date = screen.getByRole("button", { name: /GMT|UTC|:\d\d:\d\d/ });
        await click(date);
        expect(actor.getAttribute("aria-pressed")).toBe("false");
        expect(highlighted()).toEqual(['  "occurred_at": "2026-10-23T10:40:15Z",']);

        await click(date);
        expect(highlighted()).toEqual([]);
    });

    it("the record is not a scroll box: it is sized by its content and wraps", async () => {
        stubFetch("ok");
        await mount();
        await click(screen.getByText("lead.updated").closest("button")!);
        const record = screen.getByRole("textbox", { name: "Signed record as JSON" });
        expect(record.className).toContain("inv-overflow-hidden");
        expect(record.className).toContain("inv-whitespace-pre-wrap");
        expect(record.className).toContain("inv-absolute");
        // The coloured copy underneath holds every line, so it sets the height.
        const copyLines = document.querySelectorAll("pre [data-line]");
        expect(copyLines.length).toBe((record as HTMLTextAreaElement).value.split("\n").length);
    });

    it("Escape outside the record goes back too", async () => {
        stubFetch("ok");
        await mount();
        await click(screen.getByText("list.exported").closest("button")!);
        expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
        await act(async () => {
            fireEvent.keyDown(document.body, { key: "Escape" });
        });
        await waitFor(() => expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull());
        expect(screen.getByRole("group", { name: "Filters" })).toBeTruthy();
    });
});

describe("URL state", () => {
    beforeEach(() => {
        _resetExchangeCacheForTests();
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        sessionStorage.clear();
        sessionStorage.setItem("invoance_portal_jwt", fakeJwt("audit_logs"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("filters, rows and a section click are written to the URL", async () => {
        window.history.replaceState({}, "", "/portal");
        stubFetch("ok");
        await mount();
        await openField("Action");
        await click((await screen.findByText("document.deleted")).closest("button")!);
        await openField("Date");
        await click(screen.getByRole("button", { name: "Last 7 days" }));
        await waitFor(() => expect(window.location.search).toBe("?action=document.deleted&date=7d"));

        await click(screen.getByText("lead.updated").closest("button")!);
        await click(screen.getByRole("button", { name: /Maya Collins/ }));
        await waitFor(() =>
            expect(window.location.search).toBe("?event=aevt_one&section=actor&action=document.deleted&date=7d"),
        );
    });

    it("a reload restores the filters and the open event with its section", async () => {
        window.history.replaceState({}, "", "/portal?action=lead.updated&date=14d&event=aevt_two&section=date");
        const calls = stubFetch("ok");
        render(<AuditLogViewer persistSession autoRefresh={false} baseUrl="http://api.test" />);

        const crumb = await screen.findByRole("navigation", { name: "Breadcrumb" });
        expect(within(crumb).getByText("aevt_two")).toBeTruthy();
        expect(screen.getByRole("button", { name: /GMT|UTC|:\d\d:\d\d/ }).getAttribute("aria-pressed")).toBe("true");

        const qs = lastEventsParams(calls);
        expect(qs.get("actions")).toBe("lead.updated");
        expect(qs.get("occurred_after")).toBeTruthy();
        expect(window.location.search).toBe("?event=aevt_two&section=date&action=lead.updated&date=14d");

        // Closing an event that was opened by a reload stays on this page.
        await click(screen.getByRole("button", { name: "Audit log" }));
        expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
        expect(screen.getByText("action: lead.updated")).toBeTruthy();
        expect(window.location.search).toBe("?action=lead.updated&date=14d");
    });

    it("an event that is not on the loaded page is fetched by id", async () => {
        window.history.replaceState({}, "", "/portal?event=aevt_far");
        const calls = stubFetch("ok");
        const far = { ...EVENTS[1], id: "aevt_far", action: "far.away" };
        const base = globalThis.fetch as unknown as (i: RequestInfo | URL) => Promise<Response>;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                if (String(input).endsWith("/events/aevt_far")) {
                    calls.push(String(input));
                    return json(far);
                }
                return base(input);
            }),
        );
        render(<AuditLogViewer persistSession autoRefresh={false} baseUrl="http://api.test" />);
        const crumb = await screen.findByRole("navigation", { name: "Breadcrumb" });
        expect(within(crumb).getByText("aevt_far")).toBeTruthy();
        expect(calls.some((u) => u.endsWith("/events/aevt_far"))).toBe(true);
    });

    it("the open event's Back entry: browser Back returns to the list", async () => {
        window.history.replaceState({}, "", "/portal");
        stubFetch("ok");
        await mount();
        await click(screen.getByText("list.exported").closest("button")!);
        expect(window.location.search).toBe("?event=aevt_two");
        await act(async () => {
            window.history.back();
        });
        await waitFor(() => expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull());
        expect(window.location.search).toBe("");
    });
});

describe("pager footer", () => {
    beforeEach(() => {
        _resetExchangeCacheForTests();
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        sessionStorage.clear();
        sessionStorage.setItem("invoance_portal_jwt", fakeJwt("audit_logs"));
        window.history.replaceState({}, "", "/portal");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("hides Rows while one short page holds everything", async () => {
        stubFetch("ok");
        await mount();
        expect(screen.queryByText("Rows")).toBeNull();
        expect(screen.getByText("2 events")).toBeTruthy();
    });

    function stubManyEvents() {
        const many = Array.from({ length: 25 }, (_, i) => ({ ...EVENTS[1], id: `aevt_${i}`, action: `bulk.${i}` }));
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) =>
                String(input).includes("/events")
                    ? json({ events: many, next_cursor: "NEXT" })
                    : json({}),
            ),
        );
    }

    async function openRowsMenu(anchor: { top: number; bottom: number }, viewport: number) {
        vi.stubGlobal("innerHeight", viewport);
        vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(110);
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
            top: anchor.top,
            bottom: anchor.bottom,
            left: 0,
            right: 0,
            width: 0,
            height: anchor.bottom - anchor.top,
            x: 0,
            y: anchor.top,
            toJSON: () => ({}),
        } as DOMRect);
        render(<AuditLogViewer persistSession autoRefresh={false} baseUrl="http://api.test" />);
        const label = await screen.findByText("Rows");
        await click(within(label.closest("label")!).getByRole("button"));
        return screen.getByRole("button", { name: "50" }).closest("div.inv-absolute")!;
    }

    it("the Rows menu opens below when it fits there", async () => {
        stubManyEvents();
        const menu = await openRowsMenu({ top: 300, bottom: 332 }, 900);
        expect(menu.className).toContain("inv-top-full");
    });

    it("the Rows menu opens above when there is no room below", async () => {
        stubManyEvents();
        const menu = await openRowsMenu({ top: 820, bottom: 852 }, 900);
        expect(menu.className).toContain("inv-bottom-full");
    });
});
