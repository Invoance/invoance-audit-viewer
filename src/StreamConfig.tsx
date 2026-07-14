// Stream-config screen (the log_streams intent). Lists the org's webhook
// destinations and lets the visitor add one (URL, signing secret shown once),
// send a test delivery, and delete. All values render as TEXT (React escapes),
// so this is XSS-safe. All requests go through the viewer's authedFetch, which
// owns 401 refresh/expiry handling.

import { useCallback, useEffect, useState } from "react";
import type { AuthedFetch } from "./types";

type Stream = {
    id: string;
    type: string;
    endpoint: string | null;
    state: string;
    cursor_seq: number;
    failure_streak: number;
    last_error: string | null;
    last_delivery_at: string | null;
    created_at: string;
};

const NO_RING =
    "inv-outline-none focus:inv-outline-none focus:inv-ring-0 focus-visible:inv-outline-none focus-visible:inv-ring-0 active:inv-outline-none";

function fmtTime(iso: string | null): string {
    if (!iso) return "-";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function StreamConfig({ fetcher }: { fetcher: AuthedFetch }) {
    const [streams, setStreams] = useState<Stream[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>("");
    const [url, setUrl] = useState("");
    const [creating, setCreating] = useState(false);
    const [newSecret, setNewSecret] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<Record<string, string>>({});

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetcher("/streams");
            if (!res) return; // session expired; the viewer shows the message
            const b = await res.json().catch(() => null);
            if (!res.ok || !b) {
                setError((b && b.message) || "Could not load your stream destinations. Please try again.");
                return;
            }
            setStreams(b.streams || []);
            setError("");
        } catch {
            setError("Could not reach the server. Please try again.");
        } finally {
            setLoading(false);
        }
    }, [fetcher]);

    useEffect(() => {
        load();
    }, [load]);

    async function create(e: React.FormEvent) {
        e.preventDefault();
        if (creating || !url.trim()) return;
        setCreating(true);
        setNewSecret(null);
        setError("");
        try {
            const res = await fetcher("/streams", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "webhook", url: url.trim() }),
            });
            if (!res) return;
            const b = await res.json().catch(() => null);
            if (!res.ok || !b) {
                setError((b && b.message) || "Could not create the stream.");
                return;
            }
            setNewSecret(b.signing_secret || null);
            setUrl("");
            await load();
        } catch {
            setError("Could not create the stream.");
        } finally {
            setCreating(false);
        }
    }

    async function remove(id: string) {
        if (busyId) return;
        setBusyId(id);
        try {
            const res = await fetcher(`/streams/${encodeURIComponent(id)}`, { method: "DELETE" });
            if (!res) return;
            await load();
        } finally {
            setBusyId(null);
        }
    }

    async function test(id: string) {
        if (busyId) return;
        setBusyId(id);
        setTestResult((p) => ({ ...p, [id]: "Testing…" }));
        try {
            const res = await fetcher(`/streams/${encodeURIComponent(id)}/test`, { method: "POST" });
            if (!res) return;
            const b = await res.json().catch(() => null);
            const msg =
                b && b.delivered
                    ? `Delivered (HTTP ${b.http_status})`
                    : `Failed${b && b.http_status ? ` (HTTP ${b.http_status})` : ""}${b && b.error ? `: ${b.error}` : ""}`;
            setTestResult((p) => ({ ...p, [id]: msg }));
        } catch {
            setTestResult((p) => ({ ...p, [id]: "Failed: request error" }));
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div>
            <form onSubmit={create} className="inv-mb-5 inv-flex inv-flex-wrap inv-items-end inv-gap-3">
                <label className="inv-flex inv-w-full inv-flex-col inv-gap-1 sm:inv-w-auto">
                    <span className="inv-text-xs inv-text-foreground/50">Webhook URL (https)</span>
                    <input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://example.com/webhooks/audit"
                        className={`inv-w-full inv-rounded inv-border inv-border-border inv-bg-background inv-px-2 inv-py-1 inv-text-sm inv-text-foreground inv-outline-none focus:inv-outline-none focus:inv-border-foreground/40 sm:inv-w-96`}
                    />
                </label>
                <button
                    type="submit"
                    disabled={creating || !url.trim()}
                    className={`inv-rounded-md inv-border inv-border-border inv-px-3 inv-py-1.5 inv-text-sm hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
                >
                    {creating ? "Adding…" : "Add stream"}
                </button>
            </form>

            {error && (
                <div className="inv-mb-4 inv-rounded-md inv-border inv-border-danger/40 inv-px-3 inv-py-2 inv-text-sm inv-text-danger">
                    {error}
                </div>
            )}

            {newSecret && (
                <div className="inv-mb-4 inv-rounded-md inv-border inv-border-success/40 inv-bg-success/5 inv-px-3 inv-py-3 inv-text-sm">
                    <div className="inv-mb-1 inv-font-medium">Signing secret (shown once, copy it now)</div>
                    <code className="inv-block inv-break-all inv-rounded inv-bg-muted/60 inv-px-2 inv-py-1 inv-font-mono inv-text-xs">
                        {newSecret}
                    </code>
                    <div className="inv-mt-1 inv-text-xs inv-text-foreground/60">
                        Verify deliveries with the X-Invoance-Signature header. You will not see this again.
                    </div>
                </div>
            )}

            <div className="inv-overflow-hidden inv-rounded-md inv-border inv-border-border">
                <div className="inv-grid inv-grid-cols-[1fr_90px_150px] inv-gap-3 inv-border-b inv-border-border inv-bg-muted/40 inv-px-4 inv-py-2 inv-text-xs inv-font-medium inv-text-foreground/60">
                    <span>Endpoint</span>
                    <span>State</span>
                    <span className="inv-text-right">Actions</span>
                </div>

                {loading ? (
                    <div className="inv-px-4 inv-py-8 inv-text-sm inv-text-foreground/60">Loading…</div>
                ) : streams.length === 0 ? (
                    <div className="inv-px-4 inv-py-8 inv-text-sm inv-text-foreground/60">
                        No streams yet. Add a webhook above.
                    </div>
                ) : (
                    <div className="inv-divide-y inv-divide-border">
                        {streams.map((s) => (
                            <div
                                key={s.id}
                                className="inv-grid inv-grid-cols-[1fr_90px_150px] inv-items-center inv-gap-3 inv-px-4 inv-py-3 inv-text-sm"
                            >
                                <div className="inv-min-w-0">
                                    <div className="inv-truncate inv-font-mono inv-text-[13px]">{s.endpoint || "-"}</div>
                                    <div className="inv-truncate inv-text-xs inv-text-foreground/50">
                                        added {fmtTime(s.created_at)}
                                        {s.last_error ? `  •  last error: ${s.last_error}` : ""}
                                        {testResult[s.id] ? `  •  ${testResult[s.id]}` : ""}
                                    </div>
                                </div>
                                <div>
                                    <StateBadge state={s.state} />
                                </div>
                                <div className="inv-flex inv-items-center inv-justify-end inv-gap-2">
                                    <button
                                        onClick={() => test(s.id)}
                                        disabled={busyId === s.id}
                                        className={`inv-rounded-md inv-border inv-border-border inv-px-2 inv-py-1 inv-text-xs hover:inv-bg-muted disabled:inv-opacity-50 ${NO_RING}`}
                                    >
                                        Test
                                    </button>
                                    <button
                                        onClick={() => remove(s.id)}
                                        disabled={busyId === s.id}
                                        className={`inv-rounded-md inv-border inv-border-border inv-px-2 inv-py-1 inv-text-xs inv-text-danger hover:inv-bg-danger/10 disabled:inv-opacity-50 ${NO_RING}`}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function StateBadge({ state }: { state: string }) {
    const tone =
        state === "active"
            ? "inv-border-success/40 inv-text-success"
            : state === "error"
              ? "inv-border-warning/40 inv-text-warning"
              : state === "invalid"
                ? "inv-border-danger/40 inv-text-danger"
                : "inv-border-border inv-text-foreground/60";
    return (
        <span className={`inv-inline-block inv-rounded inv-border inv-px-1.5 inv-py-0.5 inv-text-xs ${tone}`}>
            {state}
        </span>
    );
}
