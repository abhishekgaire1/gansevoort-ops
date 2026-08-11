import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
    // Matches Next.js's own server-component module resolution so modules
    // guarded with the "server-only" package (which throws under plain
    // Node/browser resolution) can be imported directly by the manual
    // integration tests. pin.unit.test.ts never touches these modules, so
    // this only matters for tests/pin.integration.test.ts and
    // tests/withdrawal.rpc.test.ts.
    conditions: ["react-server"],
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setupEnv.ts"],
  },
});
