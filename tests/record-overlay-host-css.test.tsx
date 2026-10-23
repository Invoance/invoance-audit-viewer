// @vitest-environment jsdom
//
// 0.2.1: the signed record is a transparent textarea over a coloured copy, so
// the two must resolve to the same metrics whatever the host page's CSS. In
// 0.2.0 the dashboard's `textarea { font-size: 16px !important }` made the
// textarea larger than the copy, and its `::selection { color: white }` showed
// the textarea's text.
//
// jsdom's getComputedStyle applies rules in source order and ignores both
// specificity and !important, so it cannot show which rule a browser would
// pick (it lets preflight's plain `font-family: inherit` beat our !important
// rule). These tests pin what decides it in a browser instead: every metric is
// set in one shipped rule, explicitly and !important, at a specificity a bare
// element rule cannot reach; both layers carry that rule's class and nothing
// that competes with it. The cascade itself was checked in a real browser on
// demo/host.html (Tailwind preflight plus the dashboard's globals).

import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import EventDetail from "../src/EventDetail";
import type { AuditEvent } from "../src/types";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const VIEWER_CSS = read("../src/styles.css");
const HOST_CSS = read("../demo/host.css");

/** Declarations of the first rule whose selector is exactly `selector`. */
function block(css: string, selector: string): Map<string, string> {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(css);
    expect(m, `rule ${selector}`).not.toBeNull();
    const out = new Map<string, string>();
    for (const decl of m![1].split(";")) {
        const i = decl.indexOf(":");
        if (i > 0) out.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
    return out;
}

const EVENT: AuditEvent = {
    id: "aevt_overlay",
    seq: 1,
    occurred_at: "2026-10-23T10:40:15Z",
    ingested_at: "2026-10-23T10:40:16Z",
    action: "lead.updated",
    actor: { id: "u1", name: "Maya", type: "user" },
    targets: [{ id: "lead_1", name: "Lead 1", type: "crm_lead" }],
    context: null,
    metadata: null,
    payload_hash: "a".repeat(64),
    signature: "b".repeat(128),
    signing_public_key: "c".repeat(64),
};

// Everything that moves glyphs or line breaks, on both layers.
const PINNED = [
    "box-sizing",
    "margin",
    "padding",
    "border",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-variant-ligatures",
    "font-feature-settings",
    "font-kerning",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "text-indent",
    "text-transform",
    "tab-size",
    "-moz-tab-size",
    "white-space",
    "word-break",
    "overflow-wrap",
    "-webkit-text-size-adjust",
    "text-size-adjust",
];

describe("record overlay under host CSS", () => {
    it("the host stylesheet used for the check has the rules that broke 0.2.0", () => {
        expect(HOST_CSS).toMatch(/textarea,\s*select \{\s*font-size: 16px !important;/);
        expect(HOST_CSS).toMatch(/::selection \{[^}]*color: white;/);
    });

    it("pins every metric for both layers, !important, above element specificity", () => {
        const rule = block(VIEWER_CSS, ".inv-root .inv-record-layer");
        for (const prop of PINNED) {
            expect([prop, rule.get(prop)?.endsWith("!important")]).toEqual([prop, true]);
        }
        expect(rule.get("font-size")).toBe("12px !important");
        expect(rule.get("line-height")).toBe("19.5px !important");
        expect(rule.get("white-space")).toBe("pre-wrap !important");
        expect(rule.get("word-break")).toBe("break-all !important");
    });

    it("keeps the textarea's text transparent, also when selected", () => {
        const ta = block(VIEWER_CSS, ".inv-root textarea.inv-record-layer");
        expect(ta.get("color")).toBe("transparent !important");
        expect(ta.get("-webkit-text-fill-color")).toBe("transparent !important");
        expect(ta.get("position")).toBe("absolute !important");
        expect(ta.get("overflow")).toBe("hidden !important");
        for (const sel of [
            ".inv-root textarea.inv-record-layer::selection",
            ".inv-root textarea.inv-record-layer::-moz-selection",
        ]) {
            const r = block(VIEWER_CSS, sel);
            expect(r.get("color")).toBe("transparent !important");
            expect(r.get("background")).toMatch(/!important$/);
        }
    });

    it("both layers carry the record class and no competing typography utilities", () => {
        render(
            <div className="inv-root">
                <EventDetail event={EVENT} onBack={() => {}} section={null} onSection={() => {}} />
            </div>,
        );
        const textarea = screen.getByRole("textbox", { name: "Signed record as JSON" });
        const copy = textarea.previousElementSibling as HTMLElement;
        expect(copy.tagName).toBe("PRE");
        for (const el of [textarea, copy]) {
            expect(el.classList.contains("inv-record-layer")).toBe(true);
            const competing = [...el.classList].filter((c) =>
                /^(?:.*:)?inv-(?:font-|text-(?:xs|sm|base|lg|\[)|leading-|tracking-|p-|px-|py-|whitespace-|\[word-break|\[overflow-wrap|\[tab-size)/.test(c),
            );
            expect(competing).toEqual([]);
        }
    });
});
