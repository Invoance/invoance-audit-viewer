import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["react", "react/jsx-runtime"],
    // The whole package is client-side; the banner must survive bundling so
    // Next.js App Router consumers can import it from a server component tree.
    banner: { js: '"use client";' },
});
