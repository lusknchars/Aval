import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sem DOM. VETO e biblioteca de servidor.
    environment: "node",

    // globals: false -> describe/it/expect sao importados explicitamente.
    // Mais verboso, sem magia global, melhor tipagem.
    globals: false,

    include: ["test/**/*.test.ts"],
    // Fixtures sao dados gravados, nunca arquivos de teste.
    exclude: ["node_modules/**", "test/fixtures/**"],

    // CLAUDE.md: toda funcao pura, testavel sem rede. Teste que passa de
    // 5s provavelmente esta chamando RPC -- e isso e um bug do teste.
    testTimeout: 5_000,

    coverage: {
      // Profiler nativo do V8. Sem instrumentacao do codigo.
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // RPC fica isolado em modulo proprio e nao e coberto por teste offline.
      exclude: ["src/**/*.rpc.ts", "src/index.ts"],
    },
  },
});
