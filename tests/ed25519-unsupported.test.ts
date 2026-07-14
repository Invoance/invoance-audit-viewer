// Embed-plan B5 gate: a browser whose Web Crypto lacks Ed25519 must be
// reported as `ed25519Supported: false`, distinguishable from a tampered
// record, while an invalid key on a capable engine stays a plain failure.

import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAuditEventDetail } from "../src/auditVerify";

const EVENT = {
    org_id: "aorg_01J9ZBASE0000000000000000",
    event_id: "aevt_01J9ZBASE0000000000000001",
    seq: 1,
    ingested_at: "2026-06-10T19:47:52.901Z",
    action: "user.signed_in",
    occurred_at: "2026-06-10T19:47:52.336Z",
    actor: { type: "user", id: "user_123" },
    targets: [],
    payload_hash: "00",
    signature: "ab".repeat(64),
    signing_public_key: "cd".repeat(32),
};

function stubSubtle(importKeyError: () => Error) {
    vi.stubGlobal("crypto", {
        subtle: {
            digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
            importKey: async () => {
                throw importKeyError();
            },
            verify: async () => {
                throw new Error("unreachable: importKey rejected");
            },
        },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Ed25519 feature detection", () => {
    it("NotSupportedError from importKey means unsupported, not tampered", async () => {
        stubSubtle(() => new DOMException("Unrecognized algorithm name", "NotSupportedError"));
        const d = await verifyAuditEventDetail(EVENT);
        expect(d.canonicalOk).toBe(true);
        expect(d.signatureChecked).toBe(true);
        expect(d.ed25519Supported).toBe(false);
        expect(d.signatureValid).toBe(false);
    });

    it("TypeError (unknown algorithm) also means unsupported", async () => {
        stubSubtle(() => new TypeError("Unrecognized name."));
        const d = await verifyAuditEventDetail(EVENT);
        expect(d.ed25519Supported).toBe(false);
        expect(d.signatureValid).toBe(false);
    });

    it("DataError from importKey stays a checked failure on a capable engine", async () => {
        stubSubtle(() => new DOMException("Invalid keyData", "DataError"));
        const d = await verifyAuditEventDetail(EVENT);
        expect(d.ed25519Supported).toBe(true);
        expect(d.signatureValid).toBe(false);
    });
});
