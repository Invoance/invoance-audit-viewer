// Display formatting shared by the list and the detail view.

import type { Actor, Target } from "./types";

export function actorPrimary(a: Actor): string {
    if (!a) return "-";
    return a.name || a.id || (a.type ? a.type : "-");
}
// "October 23, 2026" over "13:40:15 GMT+3": the date and the clock with the
// viewer's timezone, so a reader never has to guess which zone a time is in.
export function fmtDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}
export function fmtClock(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
        ? ""
        : d.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hourCycle: "h23",
              timeZoneName: "short",
          });
}
export function targetName(t: Target | undefined): string {
    return t?.name || t?.id || t?.type || "?";
}
