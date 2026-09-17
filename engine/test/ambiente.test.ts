import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

/**
 * Teste de fumaca do ambiente.  Nao testa nada do VETO -- prova que a
 * fundacao esta de pe.  Sem rede: nenhuma chamada de RPC aqui.
 *
 * Quando o normalizador existir, este arquivo pode ser apagado.
 */
describe("ambiente", () => {
  it("compara bigint corretamente no expect", () => {
    // Todo valor de token no VETO e bigint. Se o runner nao comparasse
    // bigint direito, todo teste de saldo seria falso-positivo.
    const u64Max = 18_446_744_073_709_551_615n;
    expect(u64Max).toEqual(2n ** 64n - 1n);
    expect({ delta: -10n }).toEqual({ delta: -10n });
    expect(10n).not.toEqual(10);
  });

  it("decodifica uma conta de token SPL a partir dos bytes", () => {
    // O corte de escopo central do projeto: layout fixo, sem IDL.
    expect(ACCOUNT_SIZE).toBe(165);

    const dono = PublicKey.default;
    const bytes = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: dono,
        owner: dono,
        amount: 500n,
        delegateOption: 0,
        delegate: dono,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: dono,
      },
      bytes,
    );

    const lido = AccountLayout.decode(bytes);
    expect(lido.amount).toBe(500n);
    expect(typeof lido.amount).toBe("bigint");
  });

  it("faz round-trip de endereco em base58", () => {
    // A verificacao de proveniencia busca a string base58 nos contextChunks.
    const chave = new PublicKey(TOKEN_PROGRAM_ID);
    const texto = chave.toBase58();
    expect(bs58.decode(texto)).toHaveLength(32);
    expect(new PublicKey(bs58.decode(texto)).toBase58()).toBe(texto);
  });

  it("valida entrada de fronteira com zod", () => {
    // ActionContext, ToolManifest e TaskEnvelope entram por aqui.
    const proveniencia = z.enum([
      "user",
      "system",
      "retrieved",
      "memory",
      "tool_output",
    ]);
    expect(proveniencia.parse("retrieved")).toBe("retrieved");
    expect(() => proveniencia.parse("inventado")).toThrow();
  });
});
