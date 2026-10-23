// Filter chips: the model behind the single filter bar, and its mapping to the
// portal list query. Pure functions only, so the mapping is testable without
// rendering anything.
//
// - Chips on different fields combine with AND (each is its own query param).
// - Several action chips mean ANY of those actions (`actions` is a comma list).
// - Every other field takes one value on the API, so a second chip on the same
//   field replaces the first instead of producing an empty AND.
// - Date presets are rolling and open-ended: only `occurred_after` is sent, so
//   the Live refresh keeps picking up new events. A custom range sends both
//   ends, from the start of the first day to the end of the last (local time).

import type { AuditEvent } from "./types";

export type ValueField = "action" | "actor_name" | "actor_id" | "target_type" | "target_id";
export type FilterField = ValueField | "date";

export type DatePreset = "today" | "7d" | "14d" | "30d" | "custom";

export type ValueChip = {
    field: ValueField;
    value: string;
    /** Human label for an id (actor name, target name), when one is known. */
    label?: string | null;
};
export type DateChip = {
    field: "date";
    preset: DatePreset;
    /** Custom range only: local calendar dates, YYYY-MM-DD. */
    from?: string;
    to?: string;
};
export type Chip = ValueChip | DateChip;

export const FIELD_LABELS: Record<FilterField, string> = {
    actor_name: "Actor name",
    actor_id: "Actor id",
    action: "Action",
    target_type: "Target",
    target_id: "Target id",
    date: "Date",
};

/** Menu order. */
export const FILTER_FIELDS: FilterField[] = ["actor_name", "actor_id", "action", "target_type", "target_id", "date"];

/** Fields an API without the facets endpoint does not filter on. */
export const NEWER_API_FIELDS: ValueField[] = ["actor_name", "target_type"];

export const DATE_PRESETS: { preset: Exclude<DatePreset, "custom">; label: string }[] = [
    { preset: "today", label: "Today" },
    { preset: "7d", label: "Last 7 days" },
    { preset: "14d", label: "Last 14 days" },
    { preset: "30d", label: "Last 30 days" },
];

const PRESET_DAYS: Record<"7d" | "14d" | "30d", number> = { "7d": 7, "14d": 14, "30d": 30 };

function localMidnight(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Parse YYYY-MM-DD as a LOCAL calendar date (Date's own parser reads it as UTC). */
function parseLocalDate(s: string | undefined): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
}

/** The instant range a date chip stands for. `before` is null for presets. */
export function dateRange(chip: DateChip, now: Date = new Date()): { after: Date | null; before: Date | null } {
    switch (chip.preset) {
        case "today":
            return { after: localMidnight(now), before: null };
        case "7d":
        case "14d":
        case "30d":
            return { after: new Date(now.getTime() - PRESET_DAYS[chip.preset] * 86_400_000), before: null };
        case "custom": {
            const from = parseLocalDate(chip.from);
            const to = parseLocalDate(chip.to);
            const before = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999) : null;
            return { after: from, before };
        }
    }
}

/** Query params for the portal list (and the facets range). */
export function chipsToParams(chips: Chip[], now: Date = new Date()): Record<string, string> {
    const out: Record<string, string> = {};
    const actions: string[] = [];
    for (const c of chips) {
        if (c.field === "date") {
            const { after, before } = dateRange(c, now);
            if (after) out.occurred_after = after.toISOString();
            if (before) out.occurred_before = before.toISOString();
        } else if (c.field === "action") {
            if (!actions.includes(c.value)) actions.push(c.value);
        } else {
            out[c.field] = c.value;
        }
    }
    if (actions.length) out.actions = actions.join(",");
    return out;
}

function sameChip(a: Chip, b: Chip): boolean {
    if (a.field !== b.field) return false;
    if (a.field === "date" || b.field === "date") return true;
    return a.value === b.value;
}

/** Add a chip: duplicates are ignored; a non-action field replaces its old chip. */
export function addChip(chips: Chip[], chip: Chip): Chip[] {
    if (chip.field === "action") {
        return chips.some((c) => sameChip(c, chip)) ? chips : [...chips, chip];
    }
    const i = chips.findIndex((c) => c.field === chip.field);
    if (i === -1) return [...chips, chip];
    const next = chips.slice();
    next[i] = chip;
    return next;
}

export function removeChip(chips: Chip[], chip: Chip): Chip[] {
    return chips.filter((c) => !sameChip(c, chip));
}

function fmtDay(s: string | undefined): string {
    const d = parseLocalDate(s);
    return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "…";
}

/** "action: document.deleted", "date: Last 7 days", "actor id: Maya (user_maya)". */
export function chipText(chip: Chip): string {
    if (chip.field === "date") {
        const preset = DATE_PRESETS.find((p) => p.preset === chip.preset);
        const text = preset ? preset.label : `${fmtDay(chip.from)} to ${fmtDay(chip.to)}`;
        return `date: ${text}`;
    }
    const name = FIELD_LABELS[chip.field].toLowerCase();
    const shown = chip.label && chip.label !== chip.value ? `${chip.label} (${chip.value})` : chip.value;
    return `${name}: ${shown}`;
}

export type FacetValue = { value: string; label: string | null; count: number };

/** Suggestions from the rows already loaded: the fallback when the API has no
    facets endpoint. Same shape and order (count, then value) as the server. */
export function facetsFromEvents(events: AuditEvent[], field: ValueField, q: string, limit = 20): FacetValue[] {
    const counts = new Map<string, FacetValue>();
    const bump = (value: string | undefined | null, label: string | null = null) => {
        if (!value) return;
        const f = counts.get(value);
        if (f) {
            f.count++;
            if (!f.label && label) f.label = label;
        } else counts.set(value, { value, label, count: 1 });
    };
    for (const e of events) {
        switch (field) {
            case "action":
                bump(e.action);
                break;
            case "actor_name":
                bump(e.actor?.name);
                break;
            case "actor_id":
                bump(e.actor?.id, e.actor?.name ?? null);
                break;
            case "target_type":
                new Set((e.targets ?? []).map((t) => t?.type)).forEach((t) => bump(t));
                break;
            case "target_id":
                (e.targets ?? []).forEach((t) => bump(t?.id, t?.name ?? null));
                break;
        }
    }
    const needle = q.trim().toLowerCase();
    return [...counts.values()]
        .filter((f) => !needle || f.value.toLowerCase().startsWith(needle) || (f.label ?? "").toLowerCase().startsWith(needle))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, limit);
}
