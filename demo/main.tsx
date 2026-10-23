// Demo host: a plain Vite app (no Next.js, no Tailwind) consuming the BUILT
// package artifacts cross-origin against a local backend, in StrictMode so the
// single-use exchange dedup is exercised for real.
//
// Run: npm run demo
// Open: http://localhost:5173/?token=<one-time portal token>
//   or: http://localhost:5173/host.html?token=... for the same viewer under a
//       hostile host stylesheet (host.css: Tailwind preflight plus the
//       dashboard's global textarea and ::selection rules)
// (mint one: POST /v1/audit/portal_sessions with your API key)

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuditLogViewer } from "../dist/index.js";
import "../dist/styles.css";

// ?api=http://localhost:33102 points the demo at another local backend (a
// worktree build); the viewer keeps params it does not own.
const BACKEND = new URLSearchParams(window.location.search).get("api") ?? "http://localhost:33100";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <AuditLogViewer tokenFromUrl persistSession baseUrl={BACKEND} />
    </StrictMode>,
);
