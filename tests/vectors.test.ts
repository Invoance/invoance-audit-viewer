// Golden-vector gate (embed-plan B8): this package's canonicalization is the
// fourth implementation of the frozen invoance.audit/1 spec (Rust, Node SDK,
// Python SDK, here). The 15 vectors pin canonical bytes, SHA-256, and Ed25519
// signatures; any drift is a hard failure.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalAuditBytes, verifyAuditEventDetail } from "../src/auditVerify";

type Vector = {
    name: string;
    description: string;
    event: Record<string, unknown>;
    canonical_utf8: string;
    canonical_hex: string;
    payload_hash_sha256: string;
    signature_ed25519: string;
    public_key: string;
};

const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/vectors.json", import.meta.url), "utf8"),
) as { schema_id: string; vector_count: number; vectors: Vector[] };

function bytesToHex(b: Uint8Array): string {
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// JS numbers are IEEE-754 doubles: integer metadata beyond 2^53 cannot
// round-trip through JSON.parse, so that vector is out of scope for
// client-side verify in JS. Same skip (and skip-count assertion) as the
// Node SDK's golden-vector suite.
function hasUnsafeNumber(v: unknown): boolean {
    if (typeof v === "number") return !Number.isSafeInteger(v);
    if (Array.isArray(v)) return v.some(hasUnsafeNumber);
    if (v && typeof v === "object")
        return Object.values(v as Record<string, unknown>).some(hasUnsafeNumber);
    return false;
}

const safeVectors = fixture.vectors.filter((v) => !hasUnsafeNumber(v.event));

describe("golden vectors", () => {
    it("fixture is intact", () => {
        expect(fixture.schema_id).toBe("invoance.audit/1");
        expect(fixture.vectors.length).toBe(fixture.vector_count);
        expect(fixture.vectors.length).toBe(15);
    });

    it("skips exactly one int64-beyond-2^53 vector (a JS number limitation, not a bug)", () => {
        expect(fixture.vectors.length - safeVectors.length).toBe(1);
    });

    for (const v of safeVectors) {
        it(`${v.name}: canonical bytes, hash, and signature`, async () => {
            const bytes = canonicalAuditBytes(v.event);
            expect(new TextDecoder().decode(bytes)).toBe(v.canonical_utf8);
            expect(bytesToHex(bytes)).toBe(v.canonical_hex);

            const detail = await verifyAuditEventDetail({
                ...v.event,
                payload_hash: v.payload_hash_sha256,
                signature: v.signature_ed25519,
                signing_public_key: v.public_key,
            });
            expect(detail.canonicalOk).toBe(true);
            expect(detail.recomputedHash).toBe(v.payload_hash_sha256);
            expect(detail.signatureChecked).toBe(true);
            expect(detail.ed25519Supported).toBe(true);
            expect(detail.signatureValid).toBe(true);
        });

        it(`${v.name}: a single added character breaks hash and signature`, async () => {
            const tampered = { ...v.event, action: `${String(v.event.action)}x` };
            const detail = await verifyAuditEventDetail({
                ...tampered,
                payload_hash: v.payload_hash_sha256,
                signature: v.signature_ed25519,
                signing_public_key: v.public_key,
            });
            expect(detail.recomputedHash).not.toBe(v.payload_hash_sha256);
            expect(detail.signatureValid).toBe(false);
        });
    }
});
