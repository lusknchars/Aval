/**
 * O vocabulario de efeitos: o nucleo do VETO.
 *
 * Tudo que uma transacao faz e expresso nestes tipos, e tudo que um manifesto
 * de ferramenta espera e expresso nos mesmos. Com isso, "o que a transacao
 * fez" e "o que a ferramenta deveria fazer" viram dois conjuntos do mesmo
 * tipo, e a comparacao entre eles e operacao de conjunto -- nao interpretacao.
 *
 * FECHADO de proposito. Nao adicionar tipo sem decisao explicita: cada tipo
 * novo e uma regra nova em todo manifesto ja escrito.
 *
 * AGNOSTICO A PROGRAMA de proposito. Os tipos derivam do modelo de contas,
 * nao das instrucoes. Um programa nunca visto, se conceder um delegate,
 * produz DELEGATE_GRANT igual.
 */
import { z } from "zod";

/**
 * Fonte unica dos 8 tipos. O schema existe porque manifestos sao escritos a
 * mao e precisam ser validados em runtime; o tipo TS e derivado dele para que
 * nao haja duas listas capazes de divergir em silencio.
 */
export const esquemaTipoDeEfeito = z.enum([
  "BALANCE_DECREASE", // conta perdeu valor
  "BALANCE_INCREASE", // conta ganhou valor
  "DELEGATE_GRANT", // autoridade de gasto concedida a terceiro
  "AUTHORITY_CHANGE", // mint / freeze / upgrade / close authority alterada
  "OWNER_CHANGE", // dono da conta alterado
  "ACCOUNT_CREATE",
  "ACCOUNT_CLOSE",
  "PROGRAM_INVOKE", // programa chamado, inclusive via CPI
]);

export type EffectType = z.infer<typeof esquemaTipoDeEfeito>;

/** Os 8 tipos em ordem de declaracao. Derivado do schema, sem duplicar a lista. */
export const TIPOS_DE_EFEITO: readonly EffectType[] = esquemaTipoDeEfeito.options;

/** Qual autoridade mudou, quando o efeito e AUTHORITY_CHANGE. */
export const esquemaTipoDeAuthority = z.enum(["mint", "freeze", "upgrade", "close"]);
export type AuthorityKind = z.infer<typeof esquemaTipoDeAuthority>;

/**
 * Um efeito observado na simulacao.
 *
 * Campos opcionais sao opcionais porque nem todo tipo de efeito os tem:
 * PROGRAM_INVOKE nao tem `mint`, BALANCE_INCREASE nao tem `authority`.
 * A combinacao valida por tipo e responsabilidade de quem constroi (o
 * normalizador) e de quem compara (a avaliacao), nao deste arquivo.
 *
 * `amount` e sempre bigint. Valor de token nunca e number: lamports e
 * quantidade bruta de SPL sao u64, e number perde precisao acima de 2^53-1.
 */
export interface Effect {
  readonly type: EffectType;

  /** Conta afetada, em base58. */
  readonly account: string;

  /** Mint do token, ou "SOL" para o ativo nativo. */
  readonly mint?: string;

  /** Magnitude em unidades brutas (lamports para SOL, menor unidade para SPL). */
  readonly amount?: bigint;

  /** Quem recebe valor ou autoridade, em base58. */
  readonly counterparty?: string;

  /** Programa envolvido, em base58. */
  readonly program?: string;

  /** So para AUTHORITY_CHANGE: qual autoridade mudou. */
  readonly authorityKind?: AuthorityKind;
}

// ---------------------------------------------------------------- EffectSet

/**
 * Resultado da tentativa de simular. E um RESULTADO, nunca uma excecao
 * engolida: a diferenca entre "simulou e a tx falharia" e "nao consegui
 * simular" muda a decisao, e por isso e uniao discriminada -- quem consome e
 * obrigado pelo compilador a tratar os tres casos.
 */
export type ResultadoDeSimulacao =
  | { readonly status: "executada"; readonly unitsConsumed: number | null }
  | { readonly status: "falhou"; readonly erro: string; readonly unitsConsumed: number | null }
  | { readonly status: "indisponivel"; readonly motivo: string };

/**
 * Quais contas o VETO conseguiu de fato observar.
 *
 * `simulateTransaction` com a opcao `accounts` devolve SO os enderecos
 * pedidos -- o RPC nao faz descoberta. Se o normalizador nao pedir uma conta
 * que a transacao toca, existe ponto cego. Ponto cego vira achado, nao
 * silencio: e o "degradar, nao liberar" virando estrutura.
 */
export interface CoberturaDeContas {
  /** Todas as contas referenciadas pela mensagem, ja com as ALTs resolvidas. */
  readonly referenciadas: readonly string[];
  /** Contas com estado antes E depois, das quais foi possivel extrair efeito. */
  readonly observadas: readonly string[];
  /** Referenciadas sem estado observado. Nao vazio = cobertura incompleta. */
  readonly naoObservadas: readonly string[];
}

/**
 * A base factual da avaliacao: o que a transacao faria, no vocabulario fechado.
 *
 * Lista achatada de propositio. A comparacao com o manifesto e operacao de
 * conjunto, e conjunto exige elementos do mesmo tipo. Visoes por categoria
 * (contrapartes, programas, efeitos de um tipo) sao derivadas pelas funcoes
 * abaixo, nunca campos duplicados que podem divergir da lista.
 */
export interface EffectSet {
  readonly effects: readonly Effect[];
  /** Slot em que a simulacao foi avaliada. null quando indisponivel. */
  readonly slot: number | null;
  readonly simulacao: ResultadoDeSimulacao;
  readonly cobertura: CoberturaDeContas;
}

export function coberturaCompleta(cobertura: CoberturaDeContas): boolean {
  return cobertura.naoObservadas.length === 0;
}

export function efeitosDoTipo(conjunto: EffectSet, tipo: EffectType): readonly Effect[] {
  return conjunto.effects.filter((e) => e.type === tipo);
}

/** Quem recebe valor ou autoridade. E a entrada da verificacao de proveniencia. */
export function contrapartes(conjunto: EffectSet): readonly string[] {
  const vistas = new Set<string>();
  for (const e of conjunto.effects) {
    if (e.counterparty !== undefined) vistas.add(e.counterparty);
  }
  return [...vistas];
}

/** Programas invocados, inclusive por CPI. */
export function programasInvocados(conjunto: EffectSet): readonly string[] {
  const vistos = new Set<string>();
  for (const e of conjunto.effects) {
    if (e.program !== undefined) vistos.add(e.program);
  }
  return [...vistos];
}
