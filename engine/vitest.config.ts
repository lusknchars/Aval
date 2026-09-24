import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No DOM. VETO is a server-side library.
    environment: "node",

    // globals: false -> describe/it/expect are imported explicitly.
    // More verbose, no global magic, better typing.
    globals: false,

    include: ["test/**/*.test.ts"],
    // Fixtures are recorded data, never test files.
    exclude: ["node_modules/**", "test/fixtures/**"],

    // Every pure function must be testable without a network. A test that
    // takes over 5s is probably calling an RPC -- that is a bug in the test.
    testTimeout: 5_000,

    coverage: {
      // V8's native profiler. No code instrumentation.
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // RPC lives in its own module and is not covered by offline tests.
      exclude: ["src/**/*.rpc.ts", "src/index.ts"],
    },
  },
});
