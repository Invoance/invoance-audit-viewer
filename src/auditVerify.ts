// Browser-side offline verification for `invoance.audit/1` events.
//
// A port of the SDK's audit-canonical + audit-verify to the browser: the same
// frozen canonicalization (spec-audit-1.md section 4), using the Web Crypto API
// (SHA-256 + Ed25519) instead of node:crypto, so the viewer can verify an event
// the user has EDITED, entirely client-side, with no server round-trip. That is
// what makes the in-viewer tamper test honest: change a signed field and the
// proof breaks, in your own browser.
//
// Trust note: this checks the signature against the key embedded in the event
// (`signing_public_key`), which proves the payload is internally consistent
// with that key. A real tamper guarantee pins the issuer's registered key; the
// server /verify endpoint does that. For the editable demo, the embedded-key
// check is what visibly fails the instant a field is changed.
//
// Ed25519 support varies by browser. When Web Crypto cannot do Ed25519 at all
// (older Safari/Firefox), the result carries `ed25519Supported: false` so the
// UI can say "hash checked; signature not verifiable in this browser" instead
// of implying tampering.

const AUDIT_SCHEMA_ID = "invoance.audit/1";

const SIGNED_FIELDS = [
    "org_id",
    "event_id",
    "seq",
    "ingested_at",
    "action",
    "occurred_at",
    "actor",
    "targets",
    "context",
    "metadata",
] as const;

const REQUIRED_FIELDS = [
    "org_id",
    "event_id",
    "seq",
    "ingested_at",
    "action",
    "occurred_at",
    "actor",
    "targets",
] as const;

const RFC3339 =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|z|[+-]\d{2}:\d{2})$/;

/** RFC3339 -> the one canonical form (section 4.4): UTC, exactly 3 fractional digits, `Z`. */
function normalizeTs(value: string): string {
    if (typeof value !== "string") throw new Error("timestamp must be a string");
    const m = RFC3339.exec(value.trim());
    if (!m) throw new Error(`invalid RFC3339 timestamp: ${value}`);
    const [, yr, mo, dy, hh, mi, ss, frac, off] = m;
    const millis = parseInt(((frac ?? "") + "000").slice(0, 3), 10);
    let epoch = Date.UTC(+yr, +mo - 1, +dy, +hh, +mi, +ss, millis);
    if (off !== "Z" && off !== "z") {
        const sign = off[0] === "+" ? 1 : -1;
        const oh = parseInt(off.slice(1, 3), 10);
        const om = parseInt(off.slice(4, 6), 10);
        epoch -= sign * (oh * 3600 + om * 60) * 1000;
    }
    const d = new Date(epoch);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return (
        `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
        `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}Z`
    );
}

function stripNulls(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stripNulls);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (val === null || val === undefined) continue;
            out[k] = stripNulls(val);
        }
        return out;
    }
    return v;
}

function sortDeep(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            out[k] = sortDeep((v as Record<string, unknown>)[k]);
        }
        return out;
    }
    return v;
}

function buildSignedObject(event: Record<string, unknown>): Record<string, unknown> {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
        throw new Error("event must be a JSON object");
    }
    for (const f of REQUIRED_FIELDS) {
        if (event[f] === undefined || event[f] === null) {
            throw new Error(`missing required field: ${f}`);
        }
    }
    const out: Record<string, unknown> = {};
    for (const f of SIGNED_FIELDS) {
        const val = event[f];
        if (val === undefined || val === null) continue;
        out[f] = f === "occurred_at" || f === "ingested_at" ? normalizeTs(val as string) : val;
    }
    out.schema_id = AUDIT_SCHEMA_ID;
    return out;
}

/** The exact bytes that were hashed and signed, per the frozen spec. Exported
    so the golden-vector tests can gate this (fourth) implementation the same
    way as the SDKs'. */
export function canonicalAuditBytes(event: Record<string, unknown>): Uint8Array {
    const signed = sortDeep(stripNulls(buildSignedObject(event)));
    return new TextEncoder().encode(JSON.stringify(signed));
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.trim();
    if (clean.length % 2 !== 0) throw new Error("odd-length hex");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** NotSupportedError (or a TypeError for an unrecognized algorithm name) means
    this Web Crypto has no Ed25519 at all; anything else means the input was
    checked and rejected. */
function isUnsupportedError(err: unknown): boolean {
    if (err instanceof TypeError) return true;
    return (
        typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "NotSupportedError"
    );
}

type Ed25519Result = { supported: boolean; valid: boolean };

async function ed25519Verify(
    message: Uint8Array,
    signature: Uint8Array,
    pubkey: Uint8Array,
): Promise<Ed25519Result> {
    let key: CryptoKey;
    try {
        key = await crypto.subtle.importKey(
            "raw",
            pubkey as unknown as ArrayBuffer,
            { name: "Ed25519" },
            false,
            ["verify"],
        );
    } catch (err) {
        return { supported: !isUnsupportedError(err), valid: false };
    }
    try {
        const valid = await crypto.subtle.verify(
            { name: "Ed25519" },
            key,
            signature as unknown as ArrayBuffer,
            message as unknown as ArrayBuffer,
        );
        return { supported: true, valid };
    } catch (err) {
        return { supported: !isUnsupportedError(err), valid: false };
    }
}

export type BrowserVerifyDetail = {
    /** Could the canonical signed bytes be rebuilt from the content (valid shape). */
    canonicalOk: boolean;
    /** SHA-256 of the canonical bytes of the (possibly edited) content, lowercase hex. */
    recomputedHash: string;
    /** payload_hash present in the supplied content (null if removed). */
    storedHash: string | null;
    /** We had both a public key and a signature to check. */
    signatureChecked: boolean;
    /** Ed25519 over the canonical bytes verifies against the embedded key. */
    signatureValid: boolean;
    /** False when this browser's Web Crypto cannot do Ed25519 at all; the hash
        half of the verdict still stands, the signature half is unknowable here. */
    ed25519Supported: boolean;
};

/**
 * Verify one audit event offline, in the browser, computing every piece a
 * step-by-step UI needs: the recomputed hash, whether it matches, and the
 * Ed25519 result. Never throws and never returns early, so the caller can
 * always show the full breakdown.
 */
export async function verifyAuditEventDetail(
    event: Record<string, unknown>,
): Promise<BrowserVerifyDetail> {
    const e = event as Record<string, any>;

    const signedInput: Record<string, unknown> = {
        org_id: e.org_id,
        event_id: e.id ?? e.event_id,
        seq: e.seq,
        ingested_at: e.ingested_at,
        action: e.action,
        occurred_at: e.occurred_at,
        actor: e.actor,
        targets: e.targets,
    };
    if (e.context != null) signedInput.context = e.context;
    if (e.metadata != null) signedInput.metadata = e.metadata;

    const storedHash = typeof e.payload_hash === "string" ? e.payload_hash : null;

    let canonical: Uint8Array;
    try {
        canonical = canonicalAuditBytes(signedInput);
    } catch {
        return {
            canonicalOk: false,
            recomputedHash: "",
            storedHash,
            signatureChecked: false,
            signatureValid: false,
            ed25519Supported: true,
        };
    }

    const recomputedHash = await sha256Hex(canonical);
    const hasKeyAndSig = Boolean(e.signing_public_key) && Boolean(e.signature);
    let signatureValid = false;
    let ed25519Supported = true;
    if (hasKeyAndSig) {
        try {
            const r = await ed25519Verify(
                canonical,
                hexToBytes(String(e.signature)),
                hexToBytes(String(e.signing_public_key)),
            );
            signatureValid = r.valid;
            ed25519Supported = r.supported;
        } catch {
            signatureValid = false;
        }
    }

    return {
        canonicalOk: true,
        recomputedHash,
        storedHash,
        signatureChecked: hasKeyAndSig,
        signatureValid,
        ed25519Supported,
    };
}
