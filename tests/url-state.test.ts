// 0.2.0: the viewer's state in the URL. Round trip, foreign params kept, the
// prefix for host pages that use the same names, and junk ignored.

import { describe, expect, it } from "vitest";
import { readUrlState, urlFor, type UrlState } from "../src/urlState";

const EMPTY: UrlState = { chips: [], event: null, section: null, cursor: null, page: 1, rows: null };

describe("urlState", () => {
    it("round-trips chips, event, section, page and rows", () => {
        const state: UrlState = {
            chips: [
                { field: "action", value: "a.b" },
                { field: "action", value: "c.d" },
                { field: "actor_id", value: "u1" },
                { field: "target_type", value: "crm_lead" },
                { field: "date", preset: "custom", from: "2026-10-01", to: "2026-10-03" },
            ],
            event: "aevt_1",
            section: "targets",
            cursor: "CUR",
            page: 3,
            rows: 50,
        };
        const url = urlFor("https://app.test/portal", state);
        expect(readUrlState(url.slice(url.indexOf("?")))).toEqual(state);
    });

    it("keeps the host page's params and drops only its own", () => {
        const url = urlFor("https://app.test/x?tab=2&action=old&page=9#h", { ...EMPTY, chips: [{ field: "date", preset: "today" }] });
        expect(url).toBe("/x?tab=2&date=today#h");
    });

    it("writes nothing for the default view", () => {
        expect(urlFor("https://app.test/portal", { ...EMPTY, rows: 25 })).toBe("/portal");
    });

    it("uses the prefix both ways", () => {
        const url = urlFor("https://app.test/p?action=host", { ...EMPTY, chips: [{ field: "action", value: "mine" }] }, "audit_");
        expect(url).toBe("/p?action=host&audit_action=mine");
        expect(readUrlState("?action=host&audit_action=mine", "audit_").chips).toEqual([{ field: "action", value: "mine" }]);
    });

    it("ignores junk: bad dates, rows outside the choices, a page without a cursor", () => {
        const st = readUrlState("?date=yesterday&rows=7&page=4");
        expect(st.chips).toEqual([]);
        expect(st.rows).toBeNull();
        expect(st.page).toBe(1);
        expect(readUrlState("?date=2026-10-01..nope").chips).toEqual([]);
    });
});
