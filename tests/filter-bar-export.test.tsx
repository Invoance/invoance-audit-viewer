// @vitest-environment jsdom
//
// 0.3.0: the filter bar as a public export, rendered on its own by a host page
// with its own data source. It must not assume the portal: suggestions come
// only from the `fetchFacets` it is given, chips only change through
// `onChange`, and the chips map to list params with the exported
// `chipsToParams`, exactly as inside the viewer.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    chipsToParams,
    EMPTY_PROMPT,
    FilterBar,
    type Chip,
    type FacetsFetcher,
    type FacetsSupport,
    type FacetSourceEvent,
} from "../src/index";

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const VALUES: Record<string, { value: string; label: string | null; count: number }[]> = {
    action: [
        { value: "document.deleted", label: null, count: 12 },
        { value: "user.signed_in", label: null, count: 3 },
    ],
    actor_id: [{ value: "user_maya", label: "Maya Collins", count: 7 }],
    actor_name: [{ value: "Maya Collins", label: null, count: 7 }],
};

/** A host's facets fetcher: records every query and answers from VALUES. */
function hostFetcher(mode: "ok" | "404" | "null" = "ok") {
    const calls: URLSearchParams[] = [];
    const fn = vi.fn<FacetsFetcher>(async (params) => {
        calls.push(new URLSearchParams(params));
        if (mode === "null") return null;
        if (mode === "404") return json({ error: "not_found" }, 404);
        const field = params.get("field") ?? "";
        return json({ field, values: VALUES[field] ?? [] });
    });
    return { fn, calls };
}

/** A host page holding the chips in its own state, as the dashboard does. */
function Host(props: { fetchFacets: FacetsFetcher; events?: FacetSourceEvent[]; onChips?: (c: Chip[]) => void }) {
    const [chips, setChips] = useState<Chip[]>([]);
    return (
        <FilterBar
            chips={chips}
            onChange={(c) => {
                setChips(c);
                props.onChips?.(c);
            }}
            fetchFacets={props.fetchFacets}
            events={props.events}
            className="host-bar"
        />
    );
}

async function click(el: Element) {
    await act(async () => {
        fireEvent.click(el);
    });
}

async function openMenu() {
    await click(screen.getByRole("button", { name: /Filter by actors, actions, targets and dates|Add filter/ }));
}

async function openField(label: string) {
    await openMenu();
    await click(await screen.findByRole("button", { name: label }));
}

const fieldNames = () =>
    within(screen.getByRole("group", { name: "Filter by" }))
        .getAllByRole("button")
        .map((b) => b.textContent);

describe("FilterBar export", () => {
    beforeEach(() => {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        // The bar must never reach for the portal on its own.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("the exported bar called the global fetch");
            }),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("is exported from the package entry with its helpers", () => {
        expect(typeof FilterBar).toBe("function");
        expect(typeof chipsToParams).toBe("function");
        expect(EMPTY_PROMPT).toBe("Filter by actors, actions, targets and dates");
    });

    it("renders standalone: the empty prompt, its own reset root and the host's class", () => {
        const { fn } = hostFetcher();
        const { container } = render(<Host fetchFacets={fn} />);
        expect(screen.getByRole("button", { name: EMPTY_PROMPT })).toBeTruthy();
        const root = container.firstElementChild!;
        expect(root.classList.contains("inv-root")).toBe(true);
        expect(root.classList.contains("host-bar")).toBe(true);
        // Nothing is fetched until the menu opens.
        expect(fn).not.toHaveBeenCalled();
    });

    it("asks the host's fetcher for values, shows counts, and reports the picked chip through onChange", async () => {
        const { fn, calls } = hostFetcher();
        const onChips = vi.fn();
        render(<Host fetchFacets={fn} onChips={onChips} />);

        await openField("Action");
        const deleted = await screen.findByRole("button", { name: /document\.deleted/ });
        expect(deleted.textContent).toContain("12");
        expect(screen.getByRole("button", { name: /user\.signed_in/ }).textContent).toContain("3");

        // The support probe (limit 1) and the picker's own call (limit 20).
        expect(calls.map((c) => c.toString())).toEqual(["field=action&limit=1", "field=action&limit=20"]);
        expect(globalThis.fetch).not.toHaveBeenCalled();

        await click(deleted);
        expect(onChips).toHaveBeenLastCalledWith([{ field: "action", value: "document.deleted", label: null }]);
        expect(screen.getByText("action: document.deleted")).toBeTruthy();
        expect(chipsToParams(onChips.mock.lastCall![0])).toEqual({ actions: "document.deleted" });
    });

    it("is controlled: the chips shown are the ones passed in", async () => {
        const { fn } = hostFetcher();
        const onChange = vi.fn();
        const chips: Chip[] = [{ field: "actor_id", value: "user_maya", label: "Maya Collins" }];
        render(<FilterBar chips={chips} onChange={onChange} fetchFacets={fn} />);
        expect(screen.getByText("actor id: Maya Collins (user_maya)")).toBeTruthy();

        await click(screen.getByRole("button", { name: "Remove filter actor id: Maya Collins (user_maya)" }));
        expect(onChange).toHaveBeenCalledWith([]);
        // The parent did not apply it, so the chip stays.
        expect(screen.getByText("actor id: Maya Collins (user_maya)")).toBeTruthy();
    });

    it("sends the date chip's range and the typed prefix to the fetcher", async () => {
        const { fn, calls } = hostFetcher();
        const chips: Chip[] = [{ field: "date", preset: "custom", from: "2026-10-01", to: "2026-10-07" }];
        render(<FilterBar chips={chips} onChange={() => {}} fetchFacets={fn} />);

        await openField("Actor name");
        await screen.findByRole("button", { name: /Maya Collins/ });
        const range = chipsToParams(chips);
        const last = calls[calls.length - 1];
        expect(last.get("field")).toBe("actor_name");
        expect(last.get("occurred_after")).toBe(range.occurred_after);
        expect(last.get("occurred_before")).toBe(range.occurred_before);

        vi.useFakeTimers();
        try {
            await act(async () => {
                fireEvent.change(screen.getByRole("textbox", { name: "Search actor names" }), {
                    target: { value: "ma" },
                });
                await vi.advanceTimersByTimeAsync(250);
            });
        } finally {
            vi.useRealTimers();
        }
        expect(calls[calls.length - 1].get("q")).toBe("ma");
    });

    it("a 404 from the host's endpoint falls back to the rows given, without the newer fields", async () => {
        const { fn } = hostFetcher("404");
        const events: FacetSourceEvent[] = [
            { action: "lead.updated", actor: { id: "u1", name: "Maya" }, targets: [] },
            { action: "lead.updated", actor: { id: "u2", name: "Sam" }, targets: null },
            { action: "list.exported" },
        ];
        render(<Host fetchFacets={fn} events={events} />);

        await openMenu();
        await act(async () => {});
        expect(fieldNames()).toEqual(["Actor id", "Action", "Target id", "Date"]);
        await click(screen.getByRole("button", { name: "Action" }));
        const updated = await screen.findByRole("button", { name: /lead\.updated/ });
        expect(updated.textContent).toContain("2");
        expect(screen.getByRole("button", { name: /list\.exported/ })).toBeTruthy();
    });

    it("a fetcher that resolves to null keeps every field and suggests from the rows", async () => {
        const { fn } = hostFetcher("null");
        render(<Host fetchFacets={fn} events={[{ action: "lead.updated" }]} />);
        await openMenu();
        await act(async () => {});
        expect(fieldNames()).toEqual(["Actor name", "Actor id", "Action", "Target", "Target id", "Date"]);
        await click(screen.getByRole("button", { name: "Action" }));
        expect(await screen.findByRole("button", { name: /lead\.updated/ })).toBeTruthy();
    });

    it("reports what it learned about facets support to a host that keeps it", async () => {
        const { fn } = hostFetcher();
        const seen: FacetsSupport[] = [];
        function Keeper() {
            const [support, setSupport] = useState<FacetsSupport>("unknown");
            return (
                <FilterBar
                    chips={[]}
                    onChange={() => {}}
                    fetchFacets={fn}
                    facetsSupport={support}
                    onFacetsSupport={(s) => {
                        seen.push(s);
                        setSupport(s);
                    }}
                />
            );
        }
        render(<Keeper />);
        await openMenu();
        await screen.findByRole("button", { name: "Actor name" });
        await act(async () => {});
        expect(seen).toContain("yes");
    });
});
