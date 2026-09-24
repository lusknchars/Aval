import { describe, expect, it } from "vitest";
import {
  TIPOS_DE_EFEITO,
  coberturaCompleta,
  contrapartes,
  efeitosDoTipo,
  esquemaTipoDeAuthority,
  esquemaTipoDeEfeito,
  programasInvocados,
  type CoberturaDeContas,
  type Effect,
  type EffectSet,
  type ResultadoDeSimulacao,
} from "../../src/tipos/efeitos.js";

describe("vocabulario de efeitos", () => {
  it("tem exatamente os 8 tipos acordados", () => {
    // Trava proposital: o vocabulario e fechado. Se este teste falhar, alguem
    // mudou o vocabulario -- o que exige decisao explicita, nao um commit.
    expect(TIPOS_DE_EFEITO).toEqual([
      "BALANCE_DECREASE",
      "BALANCE_INCREASE",
      "DELEGATE_GRANT",
      "AUTHORITY_CHANGE",
      "OWNER_CHANGE",
      "ACCOUNT_CREATE",
      "ACCOUNT_CLOSE",
      "PROGRAM_INVOKE",
    ]);
    expect(TIPOS_DE_EFEITO).toHaveLength(8);
    expect(new Set(TIPOS_DE_EFEITO).size).toBe(8);
  });

  it("aceita tipo do vocabulario e rejeita o que esta fora", () => {
    for (const tipo of TIPOS_DE_EFEITO) {
      expect(esquemaTipoDeEfeito.parse(tipo)).toBe(tipo);
    }
    expect(esquemaTipoDeEfeito.safeParse("BALANCE_TRANSFER").success).toBe(false);
    expect(esquemaTipoDeEfeito.safeParse("balance_decrease").success).toBe(false);
    expect(esquemaTipoDeEfeito.safeParse("").success).toBe(false);
  });

  it("tem as 4 authorities do modelo de contas", () => {
    expect(esquemaTipoDeAuthority.options).toEqual(["mint", "freeze", "upgrade", "close"]);
    expect(esquemaTipoDeAuthority.safeParse("owner").success).toBe(false);
  });

  it("carrega magnitude como bigint, inclusive u64::MAX", () => {
    // u64::MAX em delegatedAmount e allowance ilimitada: o sinal mais forte
    // do sistema. Se isso passasse por number, chegaria arredondado.
    const ilimitado = 2n ** 64n - 1n;
    const efeito: Effect = {
      type: "DELEGATE_GRANT",
      account: "ATokenAccXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      counterparty: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      amount: ilimitado,
    };
    expect(efeito.amount).toBe(18446744073709551615n);
    expect(efeito.amount).not.toBe(Number(ilimitado));
  });

  it("permite efeito sem os campos que nao se aplicam ao tipo", () => {
    const invocacao: Effect = {
      type: "PROGRAM_INVOKE",
      account: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    };
    expect(invocacao.mint).toBeUndefined();
    expect(invocacao.amount).toBeUndefined();
  });
});

describe("EffectSet", () => {
  const conjunto: EffectSet = {
    effects: [
      { type: "BALANCE_DECREASE", account: "ATokenAcc", mint: "USDC", amount: 400n, counterparty: "PoolAcc" },
      { type: "BALANCE_INCREASE", account: "SolAcc", mint: "SOL", amount: 1_940_000_000n },
      { type: "PROGRAM_INVOKE", account: "JUP6", program: "JUP6" },
      { type: "DELEGATE_GRANT", account: "ATokenAcc", counterparty: "7xKX", amount: 2n ** 64n - 1n },
    ],
    slot: 502538365,
    simulacao: { status: "executada", unitsConsumed: 13476 },
    cobertura: { referenciadas: ["ATokenAcc", "SolAcc", "JUP6"], observadas: ["ATokenAcc", "SolAcc", "JUP6"], naoObservadas: [] },
  };

  it("deriva contrapartes sem repetir, para alimentar a proveniencia", () => {
    expect(contrapartes(conjunto)).toEqual(["PoolAcc", "7xKX"]);
  });

  it("deriva programas invocados", () => {
    expect(programasInvocados(conjunto)).toEqual(["JUP6"]);
  });

  it("filtra por tipo", () => {
    expect(efeitosDoTipo(conjunto, "DELEGATE_GRANT")).toHaveLength(1);
    expect(efeitosDoTipo(conjunto, "OWNER_CHANGE")).toEqual([]);
  });

  it("acusa cobertura incompleta quando sobra conta nao observada", () => {
    expect(coberturaCompleta(conjunto.cobertura)).toBe(true);
    const cega: CoberturaDeContas = {
      referenciadas: ["A", "B"],
      observadas: ["A"],
      naoObservadas: ["B"],
    };
    expect(coberturaCompleta(cega)).toBe(false);
  });

  it("distingue simulacao que falhou de simulacao indisponivel", () => {
    // Os dois tem zero efeitos. Se fossem indistinguiveis, "nao consegui
    // simular" viraria "a transacao nao faz nada" -- ou seja, um ALLOW.
    const falhou: ResultadoDeSimulacao = {
      status: "falhou",
      erro: '{"InsufficientFundsForRent":{"account_index":1}}',
      unitsConsumed: 150,
    };
    const indisponivel: ResultadoDeSimulacao = { status: "indisponivel", motivo: "timeout do RPC" };
    expect(falhou.status).not.toBe(indisponivel.status);

    const descrever = (r: ResultadoDeSimulacao): string => {
      switch (r.status) {
        case "executada":
          return "executou";
        case "falhou":
          return "executou e falharia";
        case "indisponivel":
          return "nao foi possivel simular";
      }
    };
    expect(descrever(falhou)).toBe("executou e falharia");
    expect(descrever(indisponivel)).toBe("nao foi possivel simular");
  });
});
