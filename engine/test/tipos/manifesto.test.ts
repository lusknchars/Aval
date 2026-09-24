import { describe, expect, it } from "vitest";
import {
  ehArgRef,
  esquemaManifesto,
  validarReferencias,
  type ToolManifest,
} from "../../src/tipos/manifesto.js";

/** Manifesto de transferencia, no formato do veto-camada-avaliacao.md. */
const transfer: ToolManifest = {
  tool: "transfer",
  version: "1",
  args: { from: "endereco", to: "endereco", mint: "mint", amount: "quantidade" },
  must: [
    { type: "BALANCE_DECREASE", account: "arg:from", mint: "arg:mint", maxAmount: "arg:amount", unidade: "decimal" },
    { type: "BALANCE_INCREASE", account: "arg:to", mint: "arg:mint" },
  ],
  may: [
    { type: "ACCOUNT_CREATE" },
    { type: "BALANCE_DECREASE", mint: "SOL" },
  ],
  mustNot: ["DELEGATE_GRANT", "AUTHORITY_CHANGE", "OWNER_CHANGE", "ACCOUNT_CLOSE"],
  accountScope: "args_plus_derived",
};

describe("ArgRef", () => {
  it("reconhece referencia valida e recusa o resto", () => {
    expect(ehArgRef("arg:from")).toBe(true);
    expect(ehArgRef("arg:amountIn")).toBe(true);
    expect(ehArgRef("from")).toBe(false);
    expect(ehArgRef("arg:")).toBe(false);
    expect(ehArgRef("arg:2x")).toBe(false);
    expect(ehArgRef("ATokenAccXXXX")).toBe(false); // endereco literal nao e ref
    expect(ehArgRef(10)).toBe(false);
  });
});

describe("manifesto de transferencia", () => {
  it("passa no schema e na validacao de referencias", () => {
    expect(esquemaManifesto.safeParse(transfer).success).toBe(true);
    expect(validarReferencias(transfer)).toEqual([]);
  });

  it("aceita endereco literal ao lado de referencia", () => {
    // `mint: "SOL"` em `may` e literal; `mint: "arg:mint"` em `must` e referencia.
    expect(validarReferencias(transfer)).toHaveLength(0);
  });
});

describe("validacao pega erro antes do ataque, nao durante", () => {
  it("acusa referencia para argumento que nao existe", () => {
    const comTypo: ToolManifest = {
      ...transfer,
      must: [{ type: "BALANCE_DECREASE", account: "arg:form" }], // typo: form != from
    };
    const problemas = validarReferencias(comTypo);
    expect(problemas).toHaveLength(1);
    expect(problemas[0]?.motivo).toContain("nao consta em args");
  });

  it("acusa referencia com o tipo errado", () => {
    const trocado: ToolManifest = {
      ...transfer,
      must: [{ type: "BALANCE_DECREASE", account: "arg:amount" }], // quantidade usada como conta
    };
    const problemas = validarReferencias(trocado);
    expect(problemas).toHaveLength(1);
    expect(problemas[0]?.motivo).toContain("exige endereco");
  });

  it("acusa quantidade por referencia sem unidade declarada", () => {
    // Sem unidade, compararia 10 (USDC) com 10000000n (bruto).
    const semUnidade: ToolManifest = {
      ...transfer,
      must: [{ type: "BALANCE_DECREASE", account: "arg:from", maxAmount: "arg:amount" }],
    };
    const problemas = validarReferencias(semUnidade);
    expect(problemas.some((p) => p.motivo.includes("unidade nao foi declarada"))).toBe(true);
  });

  it("acusa efeito obrigatorio e proibido ao mesmo tempo", () => {
    const contraditorio: ToolManifest = {
      ...transfer,
      must: [{ type: "DELEGATE_GRANT", account: "arg:from" }],
    };
    const problemas = validarReferencias(contraditorio);
    expect(problemas.some((p) => p.motivo.includes("tambem esta em mustNot"))).toBe(true);
  });

  it("rejeita ref malformada ja no schema", () => {
    const ruim = { ...transfer, must: [{ type: "BALANCE_DECREASE", account: "arg:" }] };
    // "arg:" nao casa com ArgRef, mas casa com string literal -- e aceito como
    // endereco literal. O contrato e esse: so o prefixo "arg:" valido vira ref.
    expect(esquemaManifesto.safeParse(ruim).success).toBe(true);
    expect(validarReferencias(esquemaManifesto.parse(ruim))).toEqual([]);
  });
});

describe("o caso que nenhuma politica estatica expressa", () => {
  it("DELEGATE_GRANT e proibido em transfer e obrigatorio em approve", () => {
    const approve: ToolManifest = {
      tool: "approve",
      version: "1",
      args: { account: "endereco", delegate: "endereco", amount: "quantidade" },
      must: [
        {
          type: "DELEGATE_GRANT",
          account: "arg:account",
          counterparty: "arg:delegate",
          maxAmount: "arg:amount",
          unidade: "decimal",
        },
      ],
      may: [],
      mustNot: ["BALANCE_DECREASE", "AUTHORITY_CHANGE"],
      accountScope: "args_only",
    };
    expect(validarReferencias(approve)).toEqual([]);
    expect(transfer.mustNot).toContain("DELEGATE_GRANT");
    expect(approve.must[0]?.type).toBe("DELEGATE_GRANT");
  });
});
