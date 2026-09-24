/**
 * O veredito: a fronteira de saida da camada de avaliacao.
 *
 * Nao existe score numerico aqui, de proposito. Soma ponderada e impossivel de
 * explicar a um auditor e impossivel de calibrar com confianca. A combinacao e
 * por TETO DE SEVERIDADE, e toda decisao e rastreavel ate um achado nomeado e
 * uma regra especifica.
 */
import { z } from "zod";

/** Qual verificacao produziu o achado. */
export const esquemaVerificacao = z.enum([
  "undeclared", // A -- efeito que o manifesto nao preve
  "magnitude", // B -- valor diverge do declarado no tool call
  "provenance", // C -- origem da contraparte
  "aggregate", // D -- janela deslizante, sequencia
  "content", // E -- classificador de conteudo na ingestao
  "envelope", // ferramenta ou valor fora do escopo autorizado da tarefa
  "coverage", // degradacao: sem manifesto, sem simulacao, conta nao observada
]);
export type CheckKind = z.infer<typeof esquemaVerificacao>;

/** Do menos para o mais grave. A ordem do array E a ordenacao. */
export const esquemaSeveridade = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof esquemaSeveridade>;

export const SEVERIDADES: readonly Severity[] = esquemaSeveridade.options;

export function comparaSeveridade(a: Severity, b: Severity): number {
  return SEVERIDADES.indexOf(a) - SEVERIDADES.indexOf(b);
}

export function severidadeMaxima(severidades: readonly Severity[]): Severity | null {
  return severidades.reduce<Severity | null>(
    (maior, s) => (maior === null || comparaSeveridade(s, maior) > 0 ? s : maior),
    null,
  );
}

/**
 * Um achado.
 *
 * `detail` e ESTRUTURADO, nunca texto livre: e o que permite responder, meses
 * depois, exatamente o que disparou. `explanation` e gerado por LLM depois da
 * decisao, so para exibicao, e nunca participa do veredito.
 */
export interface Finding {
  readonly check: CheckKind;
  readonly severity: Severity;
  /** Identificador estavel da regra que disparou. Ex.: "mustNot.DELEGATE_GRANT". */
  readonly rule: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly explanation?: string;
}

export const esquemaDecisao = z.enum(["allow", "flag", "deny"]);
export type Decision = z.infer<typeof esquemaDecisao>;

export interface Verdict {
  readonly actionId: string;
  readonly decision: Decision;
  readonly findings: readonly Finding[];
  /** Milissegundos desde a epoca. */
  readonly evaluatedAt: number;
  /**
   * Qual conjunto de regras estava em vigor. Existe para responder, meses
   * depois de um incidente, qual politica valia no momento.
   */
  readonly policyVersion: string;
}

/** Limiares de combinacao. Configuravel por cliente; o veredito registra a versao. */
export interface Limiares {
  /** Quantos achados `high` bastam para DENY. Padrao 2. */
  readonly altosParaDeny: number;
  /** Quantos achados `medium` bastam para FLAG. Padrao 1. */
  readonly mediosParaFlag: number;
}

export const LIMIARES_PADRAO: Limiares = { altosParaDeny: 2, mediosParaFlag: 1 };
