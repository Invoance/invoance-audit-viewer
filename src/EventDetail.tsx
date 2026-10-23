// The event detail, shown in place of the list (no drawer: the component is
// embedded in other people's pages, so it stays inside its own box). One card: on the left the
// event's sections, each a button that highlights its lines in the record; on
// the right the full signed record, sized to its content with long values
// wrapping; along the bottom the signature check.
//
// The record doubles as the append-only tamper test. It is a transparent
// textarea laid over a syntax-coloured copy of the same text (same font,
// padding and wrapping), so the highlight and the colours show through while
// the text stays editable. The copy also gives the box its height, so it never
// scrolls.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { verifyAuditEventDetail } from "./auditVerify";
import { actorPrimary, fmtClock, fmtDate, targetName } from "./format";
import { Activity, Box, Calendar, Globe, ShieldCheck, User } from "./icons";
import type { AuditEvent } from "./types";
import { FOCUS_RING } from "./ui";

// True when `original` is a subsequence of `candidate`: the candidate only ADDS
// characters, never removes or replaces one. This makes the editor append-only:
// you can type extra text into any field to test tampering, but you cannot
// delete the record or shorten a value.
function isInsertionOnly(original: string, candidate: string): boolean {
    if (candidate.length < original.length) return false;
    let i = 0;
    for (let j = 0; j < candidate.length && i < original.length; j++) {
        if (candidate[j] === original[i]) i++;
    }
    return i === original.length;
}

type VerifyState =
    | { kind: "json_error" }
    | {
          kind: "checked";
          recomputedHash: string;
          contentMatches: boolean;
          signatureChecked: boolean;
          signatureValid: boolean;
          ed25519Supported: boolean;
      };

type SectionId = "actor" | "action" | "date" | "targets" | "context" | "signature";

/** Top-level record keys each section points at. */
const SECTION_KEYS: Record<SectionId, string[]> = {
    actor: ["actor"],
    action: ["action", "id"],
    date: ["occurred_at"],
    targets: ["targets"],
    context: ["context"],
    signature: ["payload_hash", "signature", "signing_public_key"],
};

/** Line range of each top-level key in 2-space-indented JSON text. Works on
    the edited text too: insertions only ever extend a key's block. */
function keyLineRanges(text: string): Map<string, [number, number]> {
    const ranges = new Map<string, [number, number]>();
    const lines = text.split("\n");
    let cur: { key: string; start: number } | null = null;
    lines.forEach((line, i) => {
        const k = /^ {2}"((?:[^"\\]|\\.)*)"\s*:/.exec(line);
        if (k) {
            if (cur) ranges.set(cur.key, [cur.start, i - 1]);
            cur = { key: k[1], start: i };
        } else if (cur && /^\}/.test(line)) {
            ranges.set(cur.key, [cur.start, i - 1]);
            cur = null;
        }
    });
    if (cur) {
        const c = cur as { key: string; start: number };
        ranges.set(c.key, [c.start, lines.length - 1]);
    }
    return ranges;
}

// Token colours: keys muted, strings green, numbers and literals amber,
// punctuation faint. Every character of the line is emitted exactly once, so
// the coloured copy wraps exactly like the textarea above it.
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;
function colourLine(line: string): ReactNode[] {
    const out: ReactNode[] = [];
    let last = 0;
    let n = 0;
    for (const m of line.matchAll(TOKEN)) {
        const at = m.index ?? 0;
        if (at > last) out.push(line.slice(last, at));
        const [whole, str, colon, num, lit, punct] = m;
        if (str !== undefined && colon !== undefined) {
            out.push(
                <span key={n++} className="inv-text-foreground/60">
                    {str}
                </span>,
                <span key={n++} className="inv-text-foreground/40">
                    {colon}
                </span>,
            );
        } else if (str !== undefined) {
            out.push(
                <span key={n++} className="inv-text-success">
                    {str}
                </span>,
            );
        } else if (num !== undefined || lit !== undefined) {
            out.push(
                <span key={n++} className="inv-text-warning">
                    {whole}
                </span>,
            );
        } else if (punct !== undefined) {
            out.push(
                <span key={n++} className="inv-text-foreground/40">
                    {whole}
                </span>,
            );
        } else out.push(whole);
        last = at + whole.length;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
}

// Shared by the textarea and the coloured copy beneath it. Every metric lives
// in styles.css (.inv-record-layer), explicit and !important, so host CSS
// cannot move one layer without the other.
const RECORD_TEXT = "inv-record-layer";

const SECTION_IDS = Object.keys(SECTION_KEYS) as SectionId[];

export default function EventDetail({
    event,
    onBack,
    section,
    onSection,
}: {
    event: AuditEvent;
    onBack: () => void;
    /** The highlighted section; owned by the viewer so it lives in the URL. */
    section: string | null;
    onSection: (s: string | null) => void;
}) {
    const [jsonText, setJsonText] = useState("");
    const [verifying, setVerifying] = useState(false);
    const [result, setResult] = useState<VerifyState | null>(null);
    const active = SECTION_IDS.includes(section as SectionId) ? (section as SectionId) : null;
    const originalRef = useRef("");
    const headingRef = useRef<HTMLHeadingElement>(null);
    const copyRef = useRef<HTMLPreElement>(null);

    // Reset the editor, result and highlight whenever a different event is shown.
    useEffect(() => {
        const o = JSON.stringify(event, null, 2);
        originalRef.current = o;
        setJsonText(o);
        setResult(null);
    }, [event]);

    // Move focus into the view; Escape goes back (not while editing the record).
    const onBackRef = useRef(onBack);
    onBackRef.current = onBack;
    useEffect(() => {
        headingRef.current?.focus();
    }, [event.id]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (e.key === "Escape" && !(t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT"))) onBackRef.current();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);

    const edited = jsonText !== originalRef.current;
    const sealedHash = String((event as unknown as { payload_hash?: unknown }).payload_hash ?? "");
    const targets = Array.isArray(event.targets) ? event.targets : [];
    const lines = useMemo(() => (jsonText || JSON.stringify(event, null, 2)).split("\n"), [jsonText, event]);

    const highlighted = useMemo(() => {
        const set = new Set<number>();
        if (!active) return set;
        const ranges = keyLineRanges(lines.join("\n"));
        for (const key of SECTION_KEYS[active]) {
            const r = ranges.get(key);
            if (r) for (let i = r[0]; i <= r[1]; i++) set.add(i);
        }
        return set;
    }, [active, lines]);

    // Bring the first highlighted line into view when a section is picked.
    useEffect(() => {
        if (!active || highlighted.size === 0) return;
        const first = Math.min(...highlighted);
        copyRef.current
            ?.querySelector<HTMLElement>(`[data-line="${first}"]`)
            ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // Append-only guard: accept the edit only if it adds characters.
    function onEdit(next: string) {
        if (isInsertionOnly(originalRef.current, next)) {
            setJsonText(next);
            setResult(null);
        }
    }

    function reset() {
        setJsonText(originalRef.current);
        setResult(null);
    }

    async function verify() {
        setVerifying(true);
        setResult(null);
        try {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(jsonText);
            } catch {
                setResult({ kind: "json_error" });
                return;
            }
            const d = await verifyAuditEventDetail(parsed);
            setResult({
                kind: "checked",
                recomputedHash: d.recomputedHash,
                // Compare against the hash sealed when the record was signed, so
                // editing payload_hash in the box cannot make a tampered record pass.
                contentMatches: d.canonicalOk && sealedHash !== "" && d.recomputedHash === sealedHash,
                signatureChecked: d.signatureChecked,
                signatureValid: d.signatureValid,
                ed25519Supported: d.ed25519Supported,
            });
        } finally {
            setVerifying(false);
        }
    }

    const toggle = (id: SectionId) => onSection(active === id ? null : id);
    const targetTypes = new Set(targets.map((t) => t?.type).filter(Boolean));
    const targetHeadline =
        targets.length === 0
            ? "No targets"
            : targetTypes.size === 1
              ? `${targets.length} ${[...targetTypes][0]}${targets.length === 1 ? "" : "s"}`
              : `${targets.length} targets`;

    return (
        <div>
            <nav aria-label="Breadcrumb" className="inv-mb-4 inv-text-sm">
                <ol className="inv-flex inv-min-w-0 inv-items-center inv-gap-1.5">
                    <li>
                        <button
                            type="button"
                            onClick={onBack}
                            className={`inv-text-foreground/60 hover:inv-text-foreground hover:inv-underline ${FOCUS_RING}`}
                        >
                            Audit log
                        </button>
                    </li>
                    <li aria-hidden className="inv-text-foreground/30">
                        /
                    </li>
                    <li aria-current="page" className="inv-min-w-0 inv-truncate inv-font-mono inv-text-[13px]">
                        {event.id}
                    </li>
                </ol>
            </nav>

            <div className="inv-overflow-hidden inv-border inv-border-border inv-bg-background">
                <div className="inv-grid inv-grid-cols-1 md:inv-grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
                    {/* Sections */}
                    <div className="inv-min-w-0 inv-p-3">
                        <div className="inv-border-b inv-border-border inv-px-3 inv-pb-4 inv-pt-3">
                            <h2
                                ref={headingRef}
                                tabIndex={-1}
                                className="inv-text-lg inv-font-semibold inv-tracking-tight focus:inv-outline-none"
                            >
                                Audit log event
                            </h2>
                            <div className="inv-truncate inv-font-mono inv-text-xs inv-text-foreground/60" title={event.id}>
                                {event.id}
                            </div>
                        </div>
                        <div className="inv-mt-2 inv-space-y-1" role="group" aria-label="Event sections">
                            <Section id="actor" active={active} onToggle={toggle} icon={<User />} title={actorPrimary(event.actor)}>
                                {[event.actor?.type, event.actor?.name && event.actor?.id ? event.actor.id : null]
                                    .filter(Boolean)
                                    .join("  •  ") || "-"}
                            </Section>
                            <Section
                                id="action"
                                active={active}
                                onToggle={toggle}
                                icon={<Activity />}
                                title={event.action}
                                mono
                            >
                                {event.id}
                            </Section>
                            <Section
                                id="date"
                                active={active}
                                onToggle={toggle}
                                icon={<Calendar />}
                                title={fmtDate(event.occurred_at)}
                            >
                                <span className="inv-tabular-nums">{fmtClock(event.occurred_at)}</span>
                            </Section>
                            <Section id="targets" active={active} onToggle={toggle} icon={<Box />} title={targetHeadline}>
                                {targets.map((t) => targetName(t)).join(", ") || "-"}
                            </Section>
                            <Section
                                id="context"
                                active={active}
                                onToggle={toggle}
                                icon={<Globe />}
                                title={event.context?.location || "No location"}
                            >
                                {event.context?.user_agent || "No user agent"}
                            </Section>
                            <Section
                                id="signature"
                                active={active}
                                onToggle={toggle}
                                icon={<ShieldCheck />}
                                title="Signed event"
                            >
                                Ed25519  •  sequence {event.seq}
                            </Section>
                        </div>
                    </div>

                    {/* The signed record */}
                    <div className="inv-min-w-0 inv-border-t inv-border-border inv-bg-muted/40 md:inv-border-l md:inv-border-t-0">
                        <div className="inv-flex inv-items-center inv-justify-between inv-gap-3 inv-border-b inv-border-border inv-px-4 inv-py-2">
                            <span className="inv-text-xs inv-text-foreground/60">
                                Signed record. Add text to any value to test tamper detection.
                            </span>
                            <button
                                type="button"
                                onClick={reset}
                                disabled={!edited}
                                className={`inv-shrink-0 inv-text-xs ${
                                    edited
                                        ? "inv-text-foreground/70 hover:inv-text-foreground"
                                        : "inv-cursor-not-allowed inv-text-foreground/25"
                                } ${FOCUS_RING}`}
                            >
                                Reset
                            </button>
                        </div>
                        <div className="inv-relative">
                            <pre ref={copyRef} aria-hidden className={`${RECORD_TEXT} inv-text-foreground`}>
                                {lines.map((line, i) => (
                                    <span
                                        key={i}
                                        data-line={i}
                                        data-highlighted={highlighted.has(i) ? "" : undefined}
                                        className={`-inv-mx-4 inv-block inv-px-4 ${
                                            highlighted.has(i)
                                                ? "inv-bg-foreground/[0.06] inv-shadow-[inset_2px_0_0_hsl(var(--inv-foreground)/0.45)]"
                                                : ""
                                        }`}
                                    >
                                        {line ? colourLine(line) : " "}
                                    </span>
                                ))}
                            </pre>
                            <textarea
                                aria-label="Signed record as JSON"
                                value={jsonText}
                                onChange={(e) => onEdit(e.target.value)}
                                spellCheck={false}
                                className={RECORD_TEXT}
                            />
                        </div>
                    </div>
                </div>

                {/* Signature check, along the bottom of the card */}
                <section
                    aria-label="Signature verification"
                    className={`inv-border-t inv-border-border inv-px-6 inv-py-5 ${
                        active === "signature" ? "inv-bg-muted/60" : ""
                    }`}
                >
                    <div className="inv-mb-3 inv-flex inv-items-center inv-gap-2 inv-text-sm inv-font-medium">
                        <ShieldCheck className="inv-h-4 inv-w-4 inv-text-foreground/60" />
                        Signed event
                    </div>
                    <div className="inv-grid inv-grid-cols-1 inv-gap-3 inv-text-xs md:inv-grid-cols-2">
                        <div className="inv-min-w-0">
                            <div className="inv-text-foreground/60">Hash sealed with this record when it was signed</div>
                            <code className="inv-mt-0.5 inv-block inv-break-all inv-font-mono inv-text-foreground/80">
                                {sealedHash || "(none)"}
                            </code>
                        </div>
                        <div className="inv-min-w-0">
                            <div className="inv-text-foreground/60">Ed25519 signature</div>
                            <code className="inv-mt-0.5 inv-block inv-break-all inv-font-mono inv-text-foreground/80">
                                {event.signature || "(none)"}
                            </code>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={verify}
                        disabled={verifying}
                        className={`inv-mt-4 inv-border inv-border-foreground inv-bg-foreground inv-px-3 inv-py-1.5 inv-text-sm inv-font-medium inv-text-background hover:inv-bg-foreground/90 disabled:inv-opacity-50 ${FOCUS_RING}`}
                    >
                        {verifying ? "Checking…" : "Verify signature"}
                    </button>

                    {result?.kind === "json_error" && (
                        <div className="inv-mt-3 inv-border inv-border-danger/50 inv-px-3 inv-py-2 inv-text-sm inv-text-danger">
                            The edited record is no longer valid JSON, so it cannot be checked. Use Reset to restore
                            it.
                        </div>
                    )}

                    {result?.kind === "checked" &&
                        (() => {
                            const sigUnknowable = result.signatureChecked && !result.ed25519Supported;
                            const authentic = result.contentMatches && result.signatureValid;
                            const hashOnly = result.contentMatches && sigUnknowable;
                            return (
                                <div role="status" className="inv-mt-4 inv-space-y-3 inv-text-xs">
                                    <Step n={1} label="Hash recomputed now from the record above">
                                        <code
                                            className={`inv-block inv-break-all inv-font-mono ${
                                                result.contentMatches ? "inv-text-success" : "inv-text-danger"
                                            }`}
                                        >
                                            {result.recomputedHash || "(could not compute)"}
                                        </code>
                                    </Step>
                                    <Step n={2} label="Does it match the sealed hash?">
                                        <span className={result.contentMatches ? "inv-text-success" : "inv-text-danger"}>
                                            {result.contentMatches
                                                ? "Yes. The content is exactly what was signed."
                                                : "No. A field was changed, so the content no longer matches the sealed hash."}
                                        </span>
                                    </Step>
                                    <Step n={3} label="Signature check (Ed25519, against the key in the record)">
                                        <span
                                            className={
                                                sigUnknowable
                                                    ? "inv-text-warning"
                                                    : result.signatureValid
                                                      ? "inv-text-success"
                                                      : "inv-text-danger"
                                            }
                                        >
                                            {!result.signatureChecked
                                                ? "No signature present to check."
                                                : sigUnknowable
                                                  ? "Not verifiable in this browser: its Web Crypto lacks Ed25519. The hash check above still stands."
                                                  : result.signatureValid
                                                    ? "Valid. The signature fits the content."
                                                    : "Does not match. The signature no longer fits the content."}
                                        </span>
                                    </Step>
                                    <div
                                        className={`inv-border inv-px-3 inv-py-2 inv-text-sm inv-font-medium ${
                                            authentic
                                                ? "inv-border-success/40 inv-text-success"
                                                : hashOnly
                                                  ? "inv-border-warning/40 inv-text-warning"
                                                  : "inv-border-danger/50 inv-text-danger"
                                        }`}
                                    >
                                        {authentic
                                            ? "Authentic. This record has not been tampered with, checked entirely in your browser."
                                            : hashOnly
                                              ? "Hash verified. The content matches the sealed hash; the signature cannot be machine-checked in this browser."
                                              : "Tampered. This record was changed after it was signed."}
                                    </div>
                                </div>
                            );
                        })()}
                </section>
            </div>
        </div>
    );
}

/** One clickable section: highlights its lines in the record. */
function Section({
    id,
    active,
    onToggle,
    icon,
    title,
    mono,
    children,
}: {
    id: SectionId;
    active: SectionId | null;
    onToggle: (id: SectionId) => void;
    icon: ReactNode;
    title: string;
    mono?: boolean;
    children: ReactNode;
}) {
    const on = active === id;
    return (
        <button
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(id)}
            className={`inv-block inv-w-full inv-px-3 inv-py-2.5 inv-text-left inv-text-sm ${
                on ? "inv-bg-muted" : "hover:inv-bg-muted/50"
            } ${FOCUS_RING}`}
        >
            <span className="inv-flex inv-min-w-0 inv-items-center inv-gap-2">
                <span className="inv-h-3.5 inv-w-3.5 inv-shrink-0 inv-text-foreground/45 [&>svg]:inv-h-3.5 [&>svg]:inv-w-3.5">
                    {icon}
                </span>
                <span
                    className={`inv-truncate ${on ? "inv-font-semibold" : "inv-font-medium"} ${
                        mono ? "inv-font-mono inv-text-[13px]" : ""
                    }`}
                    title={title}
                >
                    {title}
                </span>
            </span>
            <span className="inv-mt-0.5 inv-block inv-truncate inv-pl-[22px] inv-text-foreground/60">{children}</span>
        </button>
    );
}

function Step({ n, label, children }: { n: number; label: string; children: ReactNode }) {
    return (
        <div>
            <div className="inv-mb-0.5 inv-text-foreground/60">
                <span className="inv-font-medium inv-text-foreground/80">{n}.</span> {label}
            </div>
            <div className="inv-pl-4">{children}</div>
        </div>
    );
}
