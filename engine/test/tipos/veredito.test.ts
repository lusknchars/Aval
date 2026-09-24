import { describe, expect, it } from "vitest";
import {
  LIMIARES_PADRAO,
  SEVERIDADES,
  comparaSeveridade,
  esquemaDecisao,
  esquemaSeveridade,
  esquemaVerificacao,
  severidadeMaxima,
  type Finding,
  type Verdict,
} from "../../src/tipos/veredito.js";

describe("severidade", () => {
  it("tem 4 niveis, ordenados do menos para o mais grave", () => {
    expect(SEVERIDADES).toEqual(["low", "medium", "high", "critical"]);
    expect(comparaSeveridade("critical", "high")).toBeGreaterThan(0);
    expect(comparaSeveridade("low", "medium")).toBeLessThan(0);
    expect(comparaSeveridade("high", "high")).toBe(0);
  });

  it("acha a maior severidade de uma lista", () => {
    expect(severidadeMaxima(["low", "critical", "medium"])).toBe("critical");
    expect(severidadeMaxima(["low"])).toBe("low");
    expect(severidadeMaxima([])).toBeNull();
  });
});

describe("vocabulario de verificacoes e decisoes", () => {
  it("cobre as 5 verificacoes mais envelope e degradacao", () => {
    expect(esquemaVerificacao.options).toEqual([
      "undeclared",
      "magnitude",
      "provenance",
      "aggregate",
      "content",
      "envelope",
      "coverage",
    ]);
  });

  it("tem exatamente tres decisoes possiveis", () => {
    expect(esquemaDecisao.options).toEqual(["allow", "flag", "deny"]);
    expect(esquemaDecisao.safeParse("block").success).toBe(false);
    expect(esquemaSeveridade.safeParse("fatal").success).toBe(false);
  });
});

describe("achado e veredito", () => {
  const achado: Finding = {
    check: "provenance",
    severity: "critical",
    rule: "provenance.retrieved_only",
    detail: {
      counterparty: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      encontradoEm: ["retrieved"],
      fonte: "https://blog.xyz/analise",
      confiancaDaFonte: "untrusted",
    },
  };

  it("guarda detalhe estruturado, nao texto livre", () => {
    expect(achado.detail["counterparty"]).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(typeof achado.detail["encontradoEm"]).toBe("object");
    // explanation e opcional e nao participa da decisao
    expect(achado.explanation).toBeUndefined();
  });

  it("rastreia cada achado ate uma regra nomeada", () => {
    const veredito: Verdict = {
      actionId: "acao-1",
      decision: "deny",
      findings: [achado, { check: "undeclared", severity: "critical", rule: "mustNot.DELEGATE_GRANT", detail: {} }],
      evaluatedAt: 1_758_000_000_000,
      policyVersion: "manifestos@1+limiares@1",
    };
    expect(veredito.findings.map((f) => f.rule)).toEqual([
      "provenance.retrieved_only",
      "mustNot.DELEGATE_GRANT",
    ]);
    expect(severidadeMaxima(veredito.findings.map((f) => f.severity))).toBe("critical");
    expect(veredito.policyVersion).not.toBe("");
  });

  it("tem limiares padrao coerentes com a regra de teto", () => {
    expect(LIMIARES_PADRAO.altosParaDeny).toBe(2);
    expect(LIMIARES_PADRAO.mediosParaFlag).toBe(1);
  });
});
