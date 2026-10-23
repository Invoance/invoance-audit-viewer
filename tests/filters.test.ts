// 0.2.0 filter bar: the chip model and its mapping to the portal list query,
// the date presets, and the suggestions derived from loaded rows (the
// fallback for an API without the facets endpoint).

import { describe, expect, it } from "vitest";
import {
    addChip,
    chipsToParams,
    chipText,
    dateRange,
    facetsFromEvents,
    removeChip,
    type Chip,
} from "../src/filters";
import type { AuditEvent } from "../src/types";

// A fixed local "now": Thursday 23 October 2026, 13:40:15.500 local time.
const NOW = new Date(2026, 9, 23, 13, 40, 15, 500);

describe("chipsToParams", () => {
    it("maps each value field to its list param", () => {
        const chips: Chip[] = [
            { field: "actor_name", value: "Maya Collins" },
            { field: "actor_id", value: "user_maya", label: "Maya Collins" },
            { field: "target_type", value: "crm_lead" },
            { field: "target_id", value: "lead_8841" },
        ];
        expect(chipsToParams(chips, NOW)).toEqual({
            actor_name: "Maya Collins",
            actor_id: "user_maya",
            target_type: "crm_lead",
            target_id: "lead_8841",
        });
    });

    it("joins several action chips into one comma list (any of them)", () => {
        const chips: Chip[] = [
            { field: "action", value: "document.deleted" },
            { field: "action", value: "user.signed_in" },
        ];
        expect(chipsToParams(chips, NOW)).toEqual({ actions: "document.deleted,user.signed_in" });
    });

    it("sends no params for no chips", () => {
        expect(chipsToParams([], NOW)).toEqual({});
    });

    it("sends only occurred_after for a preset, so Live keeps finding new rows", () => {
        const p = chipsToParams([{ field: "date", preset: "7d" }], NOW);
        expect(Object.keys(p)).toEqual(["occurred_after"]);
    });

    it("sends both ends for a custom range", () => {
        const p = chipsToParams([{ field: "date", preset: "custom", from: "2026-10-01", to: "2026-10-03" }], NOW);
        expect(p.occurred_after).toBe(new Date(2026, 9, 1).toISOString());
        expect(p.occurred_before).toBe(new Date(2026, 9, 3, 23, 59, 59, 999).toISOString());
    });
});

describe("date presets", () => {
    it("Today starts at local midnight and is open-ended", () => {
        const r = dateRange({ field: "date", preset: "today" }, NOW);
        expect(r.after?.getTime()).toBe(new Date(2026, 9, 23).getTime());
        expect(r.before).toBeNull();
    });

    it.each([
        ["7d", 7],
        ["14d", 14],
        ["30d", 30],
    ] as const)("%s reaches back %i days from now", (preset, days) => {
        const r = dateRange({ field: "date", preset }, NOW);
        expect(NOW.getTime() - r.after!.getTime()).toBe(days * 86_400_000);
        expect(r.before).toBeNull();
    });

    it("a custom range covers the whole first and last local day", () => {
        const r = dateRange({ field: "date", preset: "custom", from: "2026-10-20", to: "2026-10-20" }, NOW);
        expect(r.after?.getTime()).toBe(new Date(2026, 9, 20).getTime());
        expect(r.before?.getTime()).toBe(new Date(2026, 9, 20, 23, 59, 59, 999).getTime());
    });

    it("an incomplete custom range sends only the end it has", () => {
        const r = dateRange({ field: "date", preset: "custom", from: "2026-10-20" }, NOW);
        expect(r.after).not.toBeNull();
        expect(r.before).toBeNull();
    });
});

describe("addChip / removeChip", () => {
    it("adds actions side by side and ignores a duplicate", () => {
        let chips: Chip[] = [];
        chips = addChip(chips, { field: "action", value: "a" });
        chips = addChip(chips, { field: "action", value: "b" });
        chips = addChip(chips, { field: "action", value: "a" });
        expect(chips).toEqual([
            { field: "action", value: "a" },
            { field: "action", value: "b" },
        ]);
    });

    it("replaces a single-value field instead of AND-ing two values", () => {
        let chips: Chip[] = [{ field: "actor_id", value: "u1" }, { field: "action", value: "a" }];
        chips = addChip(chips, { field: "actor_id", value: "u2" });
        expect(chips).toEqual([{ field: "actor_id", value: "u2" }, { field: "action", value: "a" }]);
    });

    it("keeps one date chip", () => {
        let chips: Chip[] = [{ field: "date", preset: "today" }];
        chips = addChip(chips, { field: "date", preset: "30d" });
        expect(chips).toEqual([{ field: "date", preset: "30d" }]);
    });

    it("removes the matching chip only", () => {
        const chips: Chip[] = [
            { field: "action", value: "a" },
            { field: "action", value: "b" },
        ];
        expect(removeChip(chips, { field: "action", value: "a" })).toEqual([{ field: "action", value: "b" }]);
    });
});

describe("chipText", () => {
    it("reads as field: value", () => {
        expect(chipText({ field: "action", value: "document.deleted" })).toBe("action: document.deleted");
        expect(chipText({ field: "target_type", value: "crm_lead" })).toBe("target: crm_lead");
        expect(chipText({ field: "date", preset: "14d" })).toBe("date: Last 14 days");
    });

    it("shows the name with the id when one is known", () => {
        expect(chipText({ field: "actor_id", value: "user_maya", label: "Maya" })).toBe("actor id: Maya (user_maya)");
    });
});

function ev(partial: Partial<AuditEvent>): AuditEvent {
    return {
        id: "evt",
        seq: 1,
        occurred_at: "2026-10-23T10:00:00Z",
        ingested_at: "2026-10-23T10:00:00Z",
        action: "x",
        actor: null,
        targets: null,
        context: null,
        metadata: null,
        payload_hash: "",
        signature: "",
        signing_public_key: "",
        ...partial,
    };
}

describe("facetsFromEvents (fallback suggestions)", () => {
    const events = [
        ev({ action: "lead.updated", actor: { id: "u1", name: "Maya", type: "user" }, targets: [{ id: "l1", name: "Lead 1", type: "crm_lead" }] }),
        ev({ action: "lead.updated", actor: { id: "u1", name: "Maya", type: "user" }, targets: [{ id: "l2", type: "crm_lead" }, { id: "u9", type: "user" }] }),
        ev({ action: "list.exported", actor: { id: "u2", name: "Luis", type: "user" }, targets: [{ id: "l1", name: "Lead 1", type: "crm_lead" }] }),
    ];

    it("counts and sorts by count", () => {
        expect(facetsFromEvents(events, "action", "")).toEqual([
            { value: "lead.updated", label: null, count: 2 },
            { value: "list.exported", label: null, count: 1 },
        ]);
    });

    it("labels ids with names", () => {
        expect(facetsFromEvents(events, "actor_id", "")[0]).toEqual({ value: "u1", label: "Maya", count: 2 });
        expect(facetsFromEvents(events, "target_id", "")[0]).toEqual({ value: "l1", label: "Lead 1", count: 2 });
    });

    it("counts a target type once per event", () => {
        expect(facetsFromEvents(events, "target_type", "")).toEqual([
            { value: "crm_lead", label: null, count: 3 },
            { value: "user", label: null, count: 1 },
        ]);
    });

    it("narrows by a case-insensitive prefix of the value or its label", () => {
        expect(facetsFromEvents(events, "action", "LIST").map((f) => f.value)).toEqual(["list.exported"]);
        expect(facetsFromEvents(events, "actor_id", "lu").map((f) => f.value)).toEqual(["u2"]);
    });
});
