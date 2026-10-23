// Shared class strings for the viewer's controls.

// No focus ring on click; inputs get a subtle border-focus instead.
export const NO_RING =
    "inv-outline-none focus:inv-outline-none focus:inv-ring-0 focus-visible:inv-outline-none focus-visible:inv-ring-0 active:inv-outline-none";
export const INPUT_FOCUS = "inv-outline-none focus:inv-outline-none focus:inv-border-foreground/40";

// Keyboard focus outline for controls that must show where focus is. Outline,
// not ring: the stylesheet ships without Tailwind's base layer, so ring
// utilities compute to nothing.
export const FOCUS_RING =
    "focus:inv-outline-none focus-visible:inv-outline focus-visible:inv-outline-2 focus-visible:inv-outline-offset-2 focus-visible:inv-outline-foreground/40";

// Rows inside a popover list show focus as a filled background instead.
export const OPTION_FOCUS = "focus:inv-outline-none focus:inv-bg-muted";
