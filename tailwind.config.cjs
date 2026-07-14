/** @type {import('tailwindcss').Config} */
// All utilities are generated with the `inv-` prefix and preflight is off, so
// the shipped stylesheet cannot fight the host app's reset or utilities.
// Theming is via the --inv-* CSS variables (HSL triples), declared with
// defaults in src/styles.css and overridable by the host.
module.exports = {
    prefix: "inv-",
    corePlugins: { preflight: false },
    content: ["./src/**/*.{ts,tsx}"],
    theme: {
        extend: {
            colors: {
                background: "hsl(var(--inv-background) / <alpha-value>)",
                foreground: "hsl(var(--inv-foreground) / <alpha-value>)",
                border: "hsl(var(--inv-border) / <alpha-value>)",
                muted: "hsl(var(--inv-muted) / <alpha-value>)",
                popover: "hsl(var(--inv-popover) / <alpha-value>)",
                "popover-foreground": "hsl(var(--inv-popover-foreground) / <alpha-value>)",
                success: "hsl(var(--inv-success) / <alpha-value>)",
                danger: "hsl(var(--inv-danger) / <alpha-value>)",
                warning: "hsl(var(--inv-warning) / <alpha-value>)",
            },
        },
    },
    plugins: [],
};
