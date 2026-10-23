// The viewer's state in the page URL, so a reload, a bookmark or the browser's
// Back button lands where the reader was: the open event and its highlighted
// section, the filters, the page and the rows per page.
//
// Only the viewer's own params are touched (optionally prefixed, for embeds
// whose page uses the same names); everything else in the URL is kept. The
// one-time ?token= is never written here: it is stripped on open.
//
//   ?action=a&action=b&actor_id=u1&date=7d&page=3&cursor=...&rows=50
//   ?event=aevt_...&section=date
//   date is a preset (today, 7d, 14d, 30d) or a custom range 2026-10-01..2026-10-03

import { DATE_PRESETS, type Chip, type DatePreset, type ValueField } from "./filters";

export type UrlState = {
    chips: Chip[];
    event: string | null;
    section: string | null;
    /** Keyset cursor of the page shown, and its 1-based number. */
    cursor: string | null;
    page: number;
    rows: number | null;
};

const SINGLE_FIELDS: ValueField[] = ["actor_name", "actor_id", "target_type", "target_id"];
const KEYS = ["event", "section", "action", ...SINGLE_FIELDS, "date", "page", "cursor", "rows"];
const PRESETS = new Set<string>(DATE_PRESETS.map((p) => p.preset));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readUrlState(search: string, prefix = ""): UrlState {
    const q = new URLSearchParams(search);
    const get = (k: string) => q.get(prefix + k);
    const chips: Chip[] = [];
    for (const a of q.getAll(prefix + "action")) if (a) chips.push({ field: "action", value: a });
    for (const f of SINGLE_FIELDS) {
        const v = get(f);
        if (v) chips.push({ field: f, value: v });
    }
    const date = get("date");
    if (date && PRESETS.has(date)) {
        chips.push({ field: "date", preset: date as Exclude<DatePreset, "custom"> });
    } else if (date) {
        const [from, to] = date.split("..");
        if (DAY.test(from ?? "") && DAY.test(to ?? "")) chips.push({ field: "date", preset: "custom", from, to });
    }
    const page = Number(get("page"));
    const rows = Number(get("rows"));
    const cursor = get("cursor");
    return {
        chips,
        event: get("event") || null,
        section: get("section") || null,
        cursor: cursor && page > 1 ? cursor : null,
        page: cursor && Number.isInteger(page) && page > 1 ? page : 1,
        rows: [25, 50, 100].includes(rows) ? rows : null,
    };
}

/** The URL (path + query + hash) for `state`, keeping every foreign param. */
export function urlFor(href: string, state: UrlState, prefix = ""): string {
    const u = new URL(href);
    for (const k of KEYS) u.searchParams.delete(prefix + k);
    const set = (k: string, v: string) => u.searchParams.append(prefix + k, v);
    if (state.event) {
        set("event", state.event);
        if (state.section) set("section", state.section);
    }
    for (const c of state.chips) {
        if (c.field === "date") {
            set("date", c.preset === "custom" ? `${c.from ?? ""}..${c.to ?? ""}` : c.preset);
        } else set(c.field, c.value);
    }
    if (state.page > 1 && state.cursor) {
        set("page", String(state.page));
        set("cursor", state.cursor);
    }
    if (state.rows && state.rows !== 25) set("rows", String(state.rows));
    const qs = u.searchParams.toString();
    return u.pathname + (qs ? `?${qs}` : "") + u.hash;
}
