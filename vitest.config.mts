import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      // Vitest externalizes node_modules packages and resolves them via
      // plain Node resolution, which ignores the "react-server" export
      // condition -- so the real "server-only" package still throws
      // ("cannot be imported from a Client Component module") even with
      // `conditions: ["react-server"]` set below. Aliasing the specifier
      // itself bypasses that externalized resolution and routes it to a
      // no-op stub instead, for tests only. Production Next.js builds are
      // untouched by this config and continue to import the real package.
      "server-only": path.resolve(import.meta.dirname, "./tests/mocks/server-only.ts"),
    },
    // Kept for other packages that branch on the "react-server" condition;
    // no longer relied on for "server-only" itself (see alias above).
    conditions: ["react-server"],
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setupEnv.ts"],
  },
});
