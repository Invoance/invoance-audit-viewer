// The single filter bar: chips for the active filters, and one "Add filter"
// popover that walks field -> value. Values come from the portal facets
// endpoint (existing values, most used first, narrowed by a typed prefix). On
// an API without that endpoint (404) the suggestions come from the rows
// already loaded, and the actor-name and target-type fields are hidden since
// such an API does not filter on them either.
//
// Keyboard: the trigger opens the menu; arrows move between rows; Enter picks;
// Backspace in an empty search goes back to the field list; Escape closes and
// returns focus to the trigger.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Calendar, ChevronLeft, ChevronRight, ListFilter, Plus, Search, X } from "./icons";
import {
    addChip,
    chipText,
    DATE_PRESETS,
    facetsFromEvents,
    FIELD_LABELS,
    FILTER_FIELDS,
    NEWER_API_FIELDS,
    type Chip,
    type DateChip,
    type FacetValue,
    type FilterField,
    type ValueField,
} from "./filters";
import type { AuditEvent, AuthedFetch } from "./types";
import { FOCUS_RING, INPUT_FOCUS, OPTION_FOCUS } from "./ui";

export type FacetsSupport = "unknown" | "yes" | "no";

export type FacetsResult =
    | { kind: "ok"; values: FacetValue[] }
    /** An API that predates the facets endpoint: a 404, or, cross-origin, a
        request the browser blocks because the CORS preflight for the unknown
        route was answered 404. */
    | { kind: "unsupported" }
    /** Any other failure (5xx, bad body): suggest from loaded rows this time. */
    | { kind: "failed" };

/** GET /facets for one field. `range` carries the date chip's occurred_* params. */
export async function loadFacets(
    fetcher: AuthedFetch,
    field: ValueField,
    q: string,
    range: Record<string, string>,
    limit = 20,
): Promise<FacetsResult> {
    const qs = new URLSearchParams({ field, limit: String(limit) });
    if (q.trim()) qs.set("q", q.trim());
    if (range.occurred_after) qs.set("occurred_after", range.occurred_after);
    if (range.occurred_before) qs.set("occurred_before", range.occurred_before);
    try {
        const res = await fetcher(`/facets?${qs.toString()}`);
        if (!res) return { kind: "failed" };
        if (res.status === 404) return { kind: "unsupported" };
        if (!res.ok) return { kind: "failed" };
        const b = await res.json().catch(() => null);
        if (!b || !Array.isArray(b.values)) return { kind: "failed" };
        return {
            kind: "ok",
            values: (b.values as FacetValue[]).filter((v) => v && typeof v.value === "string"),
        };
    } catch {
        // The list endpoint on the same origin is working (we are past the
        // exchange), so a thrown request here is the blocked preflight of an
        // older API, not a dead network.
        return { kind: "unsupported" };
    }
}

type Step = { kind: "fields" } | { kind: "values"; field: ValueField } | { kind: "date" } | { kind: "custom" };

const PLURAL: Record<ValueField, string> = {
    action: "actions",
    actor_name: "actor names",
    actor_id: "actor ids",
    target_type: "targets",
    target_id: "target ids",
};

/** What the bar says while no filter is set; it is also the trigger's name. */
export const EMPTY_PROMPT = "Filter by actors, actions, targets and dates";

export default function FilterBar({
    chips,
    onChange,
    fetcher,
    events,
    range,
    facetsSupport,
    onFacetsSupport,
}: {
    chips: Chip[];
    onChange: (chips: Chip[]) => void;
    fetcher: AuthedFetch;
    /** Rows on screen: the suggestion source when facets is unavailable. */
    events: AuditEvent[];
    /** occurred_after / occurred_before of the date chip, for the facets call. */
    range: Record<string, string>;
    facetsSupport: FacetsSupport;
    onFacetsSupport: (s: FacetsSupport) => void;
}) {
    const [step, setStep] = useState<Step | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const close = (refocus = true) => {
        setStep(null);
        if (refocus) triggerRef.current?.focus();
    };

    useEffect(() => {
        if (!step) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setStep(null);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [step]);

    // Learn once whether the API has facets, so the field list can leave out
    // the fields an older API does not filter on.
    useEffect(() => {
        if (!step || facetsSupport !== "unknown") return;
        let cancelled = false;
        void loadFacets(fetcher, "action", "", range, 1).then((r) => {
            if (cancelled) return;
            if (r.kind === "ok") onFacetsSupport("yes");
            else if (r.kind === "unsupported") onFacetsSupport("no");
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, facetsSupport]);

    const pick = (chip: Chip) => {
        onChange(addChip(chips, chip));
        close();
    };

    // A picker opened before the probe answered may be for a field this API
    // turns out not to filter on: go back to the (now shorter) field list.
    useEffect(() => {
        if (facetsSupport === "no" && step?.kind === "values" && NEWER_API_FIELDS.includes(step.field)) {
            setStep({ kind: "fields" });
        }
    }, [facetsSupport, step]);

    const fields = FILTER_FIELDS.filter(
        (f) => !(facetsSupport === "no" && (NEWER_API_FIELDS as FilterField[]).includes(f)),
    );

    return (
        <div ref={rootRef} className="inv-relative inv-min-w-0 inv-flex-1">
            <div
                className="inv-flex inv-min-h-[36px] inv-cursor-text inv-flex-wrap inv-items-center inv-gap-1.5 inv-border inv-border-border inv-bg-background inv-px-2 inv-py-1"
                role="group"
                aria-label="Filters"
                // Clicking the bar's empty space opens the menu too, as the
                // trigger does; keyboard users have the trigger itself.
                onClick={(e) => {
                    if (e.target === e.currentTarget && !step) setStep({ kind: "fields" });
                }}
            >
                <ListFilter className="inv-ml-0.5 inv-h-3.5 inv-w-3.5 inv-shrink-0 inv-text-foreground/40" />
                {chips.map((c) => {
                    const text = chipText(c);
                    return (
                        <span
                            key={c.field === "date" ? "date" : `${c.field}|${c.value}`}
                            className="inv-flex inv-max-w-full inv-items-center inv-gap-1 inv-border inv-border-border inv-bg-muted/60 inv-py-0.5 inv-pl-2 inv-pr-1 inv-text-xs"
                        >
                            <span className="inv-truncate">{text}</span>
                            <button
                                type="button"
                                aria-label={`Remove filter ${text}`}
                                onClick={() => onChange(chips.filter((x) => x !== c))}
                                className={`inv-p-0.5 inv-text-foreground/50 hover:inv-bg-muted hover:inv-text-foreground ${FOCUS_RING}`}
                            >
                                <X className="inv-h-3 inv-w-3" />
                            </button>
                        </span>
                    );
                })}
                <button
                    ref={triggerRef}
                    type="button"
                    aria-haspopup="true"
                    aria-expanded={step !== null}
                    onClick={() => setStep(step ? null : { kind: "fields" })}
                    className={
                        chips.length
                            ? `inv-flex inv-items-center inv-gap-1 inv-px-1.5 inv-py-0.5 inv-text-sm inv-text-foreground/60 hover:inv-bg-muted hover:inv-text-foreground ${FOCUS_RING}`
                            : // Empty bar: the trigger fills it and reads like a search
                              // field's placeholder, so the whole bar is one target.
                              `inv-flex inv-min-w-0 inv-flex-1 inv-items-center inv-self-stretch inv-px-1 inv-text-left inv-text-sm inv-text-foreground/45 hover:inv-text-foreground/70 ${FOCUS_RING}`
                    }
                >
                    {chips.length ? (
                        <>
                            <Plus className="inv-h-3.5 inv-w-3.5" />
                            Add filter
                        </>
                    ) : (
                        <span className="inv-truncate">{EMPTY_PROMPT}</span>
                    )}
                </button>
                {chips.length > 0 && (
                    <button
                        type="button"
                        onClick={() => onChange([])}
                        className={`inv-ml-auto inv-px-1.5 inv-py-0.5 inv-text-xs inv-text-foreground/50 hover:inv-text-foreground ${FOCUS_RING}`}
                    >
                        Clear all
                    </button>
                )}
            </div>

            {step && (
                <div
                    className="inv-absolute inv-left-0 inv-top-full inv-z-50 inv-mt-1 inv-w-[320px] inv-max-w-full inv-border inv-border-border inv-bg-popover inv-text-popover-foreground inv-shadow-lg"
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            e.preventDefault();
                            close();
                        }
                    }}
                >
                    {step.kind === "fields" && (
                        <OptionList label="Filter by" rows={fields.join(",")}>
                            {fields.map((f) => (
                                <OptionButton
                                    key={f}
                                    onClick={() =>
                                        setStep(f === "date" ? { kind: "date" } : { kind: "values", field: f })
                                    }
                                >
                                    <span className="inv-flex-1">{FIELD_LABELS[f]}</span>
                                    <ChevronRight className="inv-h-3.5 inv-w-3.5 inv-text-foreground/40" />
                                </OptionButton>
                            ))}
                        </OptionList>
                    )}
                    {step.kind === "values" && (
                        <ValuePicker
                            field={step.field}
                            fetcher={fetcher}
                            events={events}
                            range={range}
                            facetsSupport={facetsSupport}
                            onFacetsSupport={onFacetsSupport}
                            chosen={chips.flatMap((c) => (c.field === step.field ? [c.value] : []))}
                            onBack={() => setStep({ kind: "fields" })}
                            onPick={(value, label) => pick({ field: step.field, value, label })}
                        />
                    )}
                    {step.kind === "date" && (
                        <>
                            <PanelHeader title="Date" onBack={() => setStep({ kind: "fields" })} />
                            <OptionList label="Date range">
                                {DATE_PRESETS.map((p) => (
                                    <OptionButton key={p.preset} onClick={() => pick({ field: "date", preset: p.preset })}>
                                        <Calendar className="inv-h-3.5 inv-w-3.5 inv-text-foreground/40" />
                                        {p.label}
                                    </OptionButton>
                                ))}
                                <OptionButton onClick={() => setStep({ kind: "custom" })}>
                                    <Calendar className="inv-h-3.5 inv-w-3.5 inv-text-foreground/40" />
                                    <span className="inv-flex-1">Custom range</span>
                                    <ChevronRight className="inv-h-3.5 inv-w-3.5 inv-text-foreground/40" />
                                </OptionButton>
                            </OptionList>
                        </>
                    )}
                    {step.kind === "custom" && (
                        <CustomRange
                            initial={chips.find((c): c is DateChip => c.field === "date" && c.preset === "custom")}
                            onBack={() => setStep({ kind: "date" })}
                            onApply={(from, to) => pick({ field: "date", preset: "custom", from, to })}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/** Arrow-key movement between the focusable rows of a popover panel. */
function moveFocus(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const panel = (e.currentTarget as HTMLElement).closest("[data-inv-panel]");
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>("[data-inv-option], [data-inv-search]"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    if (items[next]) {
        e.preventDefault();
        items[next].focus();
    }
}

function OptionList({ label, rows, children }: { label: string; rows?: string; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    // Focus the first row when the panel opens, and again if the rows change
    // under the focus (the field list shrinks once the facets probe answers).
    useEffect(() => {
        if (!ref.current?.contains(document.activeElement)) {
            ref.current?.querySelector<HTMLElement>("[data-inv-option]")?.focus();
        }
    }, [rows]);
    return (
        <div ref={ref} data-inv-panel="" role="group" aria-label={label} className="inv-max-h-72 inv-overflow-y-auto inv-py-1">
            {children}
        </div>
    );
}

function OptionButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            data-inv-option=""
            onClick={onClick}
            onKeyDown={moveFocus}
            className={`inv-flex inv-w-full inv-items-center inv-gap-2 inv-px-3 inv-py-1.5 inv-text-left inv-text-sm hover:inv-bg-muted ${OPTION_FOCUS}`}
        >
            {children}
        </button>
    );
}

function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
    return (
        <div className="inv-flex inv-items-center inv-gap-1 inv-border-b inv-border-border inv-px-1.5 inv-py-1.5">
            <button
                type="button"
                onClick={onBack}
                aria-label="Back to fields"
                className={`inv-p-1 inv-text-foreground/50 hover:inv-bg-muted ${FOCUS_RING}`}
            >
                <ChevronLeft className="inv-h-3.5 inv-w-3.5" />
            </button>
            <span className="inv-text-xs inv-font-medium inv-text-foreground/70">{title}</span>
        </div>
    );
}

function ValuePicker({
    field,
    fetcher,
    events,
    range,
    facetsSupport,
    onFacetsSupport,
    chosen,
    onBack,
    onPick,
}: {
    field: ValueField;
    fetcher: AuthedFetch;
    events: AuditEvent[];
    range: Record<string, string>;
    facetsSupport: FacetsSupport;
    onFacetsSupport: (s: FacetsSupport) => void;
    /** Values already added as chips for this field: not offered again. */
    chosen: string[];
    onBack: () => void;
    onPick: (value: string, label: string | null) => void;
}) {
    const [q, setQ] = useState("");
    const [values, setValues] = useState<FacetValue[] | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Debounced suggestion load; falls back to the loaded rows on a 404 or a
    // failed call so the picker always offers something.
    useEffect(() => {
        let cancelled = false;
        const t = setTimeout(
            async () => {
                if (facetsSupport !== "no") {
                    const r = await loadFacets(fetcher, field, q, range);
                    if (cancelled) return;
                    if (r.kind === "ok") {
                        if (facetsSupport !== "yes") onFacetsSupport("yes");
                        setValues(r.values);
                        return;
                    }
                    if (r.kind === "unsupported") onFacetsSupport("no");
                }
                if (!cancelled) setValues(facetsFromEvents(events, field, q));
            },
            q ? 200 : 0,
        );
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [field, q]);

    const typed = q.trim();
    const shown = values?.filter((v) => !chosen.includes(v.value)) ?? null;
    const alreadyAdded = typed !== "" && chosen.includes(typed);
    const exact = alreadyAdded || shown?.some((v) => v.value === typed);
    const plural = PLURAL[field];

    return (
        <div data-inv-panel="">
            <PanelHeader title={FIELD_LABELS[field]} onBack={onBack} />
            <div className="inv-flex inv-items-center inv-gap-2 inv-border-b inv-border-border inv-px-3 inv-py-1.5">
                <Search className="inv-h-3.5 inv-w-3.5 inv-shrink-0 inv-text-foreground/40" />
                <input
                    ref={inputRef}
                    data-inv-search=""
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Backspace" && q === "") {
                            e.preventDefault();
                            onBack();
                        } else if (e.key === "Enter") {
                            e.preventDefault();
                            const first = shown?.[0];
                            if (typed && !exact) onPick(typed, null);
                            else if (first) onPick(first.value, first.label);
                        } else moveFocus(e);
                    }}
                    placeholder={`Search ${plural}`}
                    aria-label={`Search ${plural}`}
                    className={`inv-w-full inv-border-0 inv-bg-transparent inv-py-0.5 inv-text-sm ${INPUT_FOCUS}`}
                />
            </div>
            <div role="group" aria-label={`${FIELD_LABELS[field]} values`} className="inv-max-h-64 inv-overflow-y-auto inv-py-1">
                {shown === null ? (
                    <div className="inv-px-3 inv-py-2 inv-text-sm inv-text-foreground/50">Loading…</div>
                ) : (
                    <>
                        {shown.map((v) => (
                            <OptionButton key={v.value} onClick={() => onPick(v.value, v.label)}>
                                <span className="inv-min-w-0 inv-flex-1">
                                    <span
                                        className={`inv-block inv-truncate ${field === "action" ? "inv-font-mono inv-text-[13px]" : ""}`}
                                    >
                                        {v.label || v.value}
                                    </span>
                                    {v.label && v.label !== v.value && (
                                        <span className="inv-block inv-truncate inv-font-mono inv-text-[11px] inv-text-foreground/50">
                                            {v.value}
                                        </span>
                                    )}
                                </span>
                                <span className="inv-shrink-0 inv-text-xs inv-tabular-nums inv-text-foreground/40">
                                    {v.count}
                                </span>
                            </OptionButton>
                        ))}
                        {typed && !exact && (
                            <OptionButton onClick={() => onPick(typed, null)}>
                                <span className="inv-truncate">
                                    Filter by <span className="inv-font-mono inv-text-[13px]">{typed}</span>
                                </span>
                            </OptionButton>
                        )}
                        {alreadyAdded && (
                            <div className="inv-px-3 inv-py-2 inv-text-sm inv-text-foreground/50">
                                <span className="inv-font-mono inv-text-[13px]">{typed}</span> is already a filter.
                            </div>
                        )}
                        {shown.length === 0 && !typed && (
                            <div className="inv-px-3 inv-py-2 inv-text-sm inv-text-foreground/50">
                                {chosen.length === 0
                                    ? "No values yet."
                                    : facetsSupport === "no"
                                      ? // Without facets the suggestions are the rows on screen,
                                        // which this field's own chips have already narrowed.
                                        `No other ${plural} on this page. Type one to add it.`
                                      : `No other ${plural} to add.`}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function CustomRange({
    initial,
    onBack,
    onApply,
}: {
    initial?: DateChip;
    onBack: () => void;
    onApply: (from: string, to: string) => void;
}) {
    const [from, setFrom] = useState(initial?.from ?? "");
    const [to, setTo] = useState(initial?.to ?? "");
    const fromRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        fromRef.current?.focus();
    }, []);
    const invalid = !from || !to || from > to;
    const input = `inv-w-full inv-border inv-border-border inv-bg-background inv-px-2 inv-py-1 inv-text-sm ${INPUT_FOCUS}`;
    return (
        <div>
            <PanelHeader title="Custom range" onBack={onBack} />
            <form
                className="inv-space-y-2 inv-p-3"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!invalid) onApply(from, to);
                }}
            >
                <label className="inv-block">
                    <span className="inv-mb-1 inv-block inv-text-xs inv-text-foreground/50">From</span>
                    <input ref={fromRef} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={input} />
                </label>
                <label className="inv-block">
                    <span className="inv-mb-1 inv-block inv-text-xs inv-text-foreground/50">To</span>
                    <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={input} />
                </label>
                <button
                    type="submit"
                    disabled={invalid}
                    className={`inv-w-full inv-border inv-border-border inv-px-3 inv-py-1.5 inv-text-sm hover:inv-bg-muted disabled:inv-opacity-50 ${FOCUS_RING}`}
                >
                    Apply
                </button>
            </form>
        </div>
    );
}
