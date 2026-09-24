/**
 * Manifesto de ferramenta: o lado esquerdo da comparacao.
 *
 * Declara, no mesmo vocabulario fechado de efeitos, o que uma ferramenta
 * legitimamente causa. Escrito a mao, uma vez, versionado junto do codigo.
 *
 * O ponto que nenhuma politica estatica alcanca: DELEGATE_GRANT e proibido em
 * `transfer` e em `swap`, e obrigatorio em `approve`. O mesmo efeito e critico
 * num contexto e esperado noutro -- o manifesto e onde essa diferenca cabe.
 */
import { z } from "zod";
import { esquemaTipoDeEfeito, type EffectType } from "./efeitos.js";

/** Referencia a um argumento do tool call. Resolve no momento da avaliacao. */
export type ArgRef = `arg:${string}`;

const PADRAO_ARG_REF = /^arg:[A-Za-z_][A-Za-z0-9_]*$/;

export function ehArgRef(valor: unknown): valor is ArgRef {
  return typeof valor === "string" && PADRAO_ARG_REF.test(valor);
}

export const esquemaArgRef = z.custom<ArgRef>(ehArgRef, {
  error: 'referencia invalida: use o formato "arg:nomeDoArgumento"',
});

/**
 * Tipo declarado de um argumento da ferramenta.
 *
 * Existe para que a resolucao possa FALHAR EXPLICITAMENTE quando o agente
 * manda o tipo errado, em vez de comparar lixo com lixo.
 */
export const esquemaTipoDeArgumento = z.enum([
  "endereco", // chave publica base58
  "mint", // mint SPL, ou "SOL"
  "quantidade", // valor numerico de token
  "texto",
]);
export type TipoDeArgumento = z.infer<typeof esquemaTipoDeArgumento>;

/**
 * Unidade em que a quantidade do tool call esta expressa.
 *
 * ESTE CAMPO EVITA O FALSO POSITIVO MAIS OBVIO DO SISTEMA. Um tool call diz
 * `amount: 10` (USDC); o efeito simulado diz `10000000n` (unidade bruta).
 * Comparar direto acusa "declarou 10, moveu 10 milhoes" em toda transferencia
 * legitima. `decimal` exige converter usando os decimals do mint antes de
 * comparar; `bruta` compara direto.
 */
export const esquemaUnidade = z.enum(["bruta", "decimal"]);
export type UnidadeDeQuantidade = z.infer<typeof esquemaUnidade>;

/** Decimals por mint, fornecido pelo normalizador. Sem isso, `decimal` nao compara. */
export type TabelaDeDecimais = ReadonlyMap<string, number>;

/**
 * Teto de folga aceito num manifesto. Acima disso deixa de ser slippage.
 * Se uma ferramenta real precisar de mais, a excecao tem que ser explicita.
 */
export const TOLERANCIA_MAXIMA = 0.1;

/** Um padrao de efeito esperado. Campos ausentes significam "nao restringe". */
export const esquemaPadraoDeEfeito = z.object({
  type: esquemaTipoDeEfeito,
  account: z.union([esquemaArgRef, z.string()]).optional(),
  mint: z.union([esquemaArgRef, z.string()]).optional(),
  counterparty: z.union([esquemaArgRef, z.string()]).optional(),
  maxAmount: z.union([esquemaArgRef, z.bigint()]).optional(),
  minAmount: z.union([esquemaArgRef, z.bigint()]).optional(),
  /**
   * Fracao aceita de folga, para slippage e taxa. 0.03 = 3%.
   *
   * Teto em TOLERANCIA_MAXIMA para pegar `0.3` digitado no lugar de `0.03`.
   * Folga alta demais e desvio dentro da tolerancia -- ninguem rouba 500,
   * rouba-se 3% de cada operacao, e a verificacao de magnitude nunca dispara.
   * O numero e CALIBRACAO, nao consequencia logica: revisar com dados reais.
   */
  tolerance: z.number().min(0).max(TOLERANCIA_MAXIMA).optional(),
  /** Obrigatorio quando ha maxAmount/minAmount vindo de arg. */
  unidade: esquemaUnidade.optional(),
});
export type EffectPattern = z.infer<typeof esquemaPadraoDeEfeito>;

/**
 * Que contas a ferramenta pode tocar.
 * Conta tocada fora do escopo e achado de severidade alta.
 */
export const esquemaEscopoDeContas = z.enum([
  "args_only", // so as contas citadas nos argumentos
  "args_plus_derived", // tambem PDAs e ATAs derivados delas
  "open", // sem restricao; usar so quando inevitavel
]);
export type AccountScope = z.infer<typeof esquemaEscopoDeContas>;

export const esquemaManifesto = z.object({
  tool: z.string().min(1),
  /** Versao do manifesto. Entra no policyVersion de cada veredito. */
  version: z.string().min(1),

  /** Os argumentos que esta ferramenta tem. Toda ArgRef precisa apontar para um deles. */
  args: z.record(z.string(), esquemaTipoDeArgumento),

  must: z.array(esquemaPadraoDeEfeito), // tem que acontecer
  may: z.array(esquemaPadraoDeEfeito), // pode acontecer
  mustNot: z.array(esquemaTipoDeEfeito), // presenca = violacao imediata

  accountScope: esquemaEscopoDeContas,
  programAllowlist: z.array(z.string()).optional(),
});
export type ToolManifest = z.infer<typeof esquemaManifesto>;

/** Problema estrutural encontrado num manifesto, antes de qualquer avaliacao. */
export interface ProblemaDeManifesto {
  readonly campo: string;
  readonly motivo: string;
}

function referenciasDoPadrao(padrao: EffectPattern): { campo: string; ref: ArgRef }[] {
  const achadas: { campo: string; ref: ArgRef }[] = [];
  const candidatos: [string, unknown][] = [
    ["account", padrao.account],
    ["mint", padrao.mint],
    ["counterparty", padrao.counterparty],
    ["maxAmount", padrao.maxAmount],
    ["minAmount", padrao.minAmount],
  ];
  for (const [campo, valor] of candidatos) {
    if (ehArgRef(valor)) achadas.push({ campo, ref: valor });
  }
  return achadas;
}

const TIPO_ESPERADO: Readonly<Record<string, TipoDeArgumento>> = {
  account: "endereco",
  counterparty: "endereco",
  mint: "mint",
  maxAmount: "quantidade",
  minAmount: "quantidade",
};

/**
 * Confere a coerencia interna do manifesto ANTES de usa-lo.
 *
 * Erro de digitacao em `arg:form` tem que estourar ao carregar o manifesto,
 * nao seis meses depois, no meio de um ataque, como uma comparacao que
 * silenciosamente nao casa com nada.
 */
export function validarReferencias(manifesto: ToolManifest): readonly ProblemaDeManifesto[] {
  const problemas: ProblemaDeManifesto[] = [];
  const declarados = manifesto.args;

  const conferir = (lista: readonly EffectPattern[], origem: string): void => {
    lista.forEach((padrao, i) => {
      for (const { campo, ref } of referenciasDoPadrao(padrao)) {
        const nome = ref.slice("arg:".length);
        const tipo = declarados[nome];
        const onde = `${origem}[${i}].${campo}`;
        if (tipo === undefined) {
          problemas.push({ campo: onde, motivo: `"${ref}" nao consta em args` });
          continue;
        }
        const esperado = TIPO_ESPERADO[campo];
        if (esperado !== undefined && tipo !== esperado) {
          problemas.push({ campo: onde, motivo: `"${ref}" e ${tipo}, mas ${campo} exige ${esperado}` });
        }
      }
      // Quantidade vinda de argumento sem unidade declarada compararia
      // 10 (USDC) com 10000000n (bruto) -- falso positivo garantido.
      const temQuantidadePorRef = ehArgRef(padrao.maxAmount) || ehArgRef(padrao.minAmount);
      if (temQuantidadePorRef && padrao.unidade === undefined) {
        problemas.push({
          campo: `${origem}[${i}].unidade`,
          motivo: "quantidade vem de argumento mas a unidade nao foi declarada",
        });
      }
    });
  };

  conferir(manifesto.must, "must");
  conferir(manifesto.may, "may");

  // Um efeito nao pode ser obrigatorio e proibido ao mesmo tempo.
  const proibidos = new Set<EffectType>(manifesto.mustNot);
  manifesto.must.forEach((padrao, i) => {
    if (proibidos.has(padrao.type)) {
      problemas.push({ campo: `must[${i}].type`, motivo: `${padrao.type} tambem esta em mustNot` });
    }
  });

  return problemas;
}
