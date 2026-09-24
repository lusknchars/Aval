/**
 * O contexto capturado no runtime do agente do cliente.
 *
 * `provenance` e o campo mais importante de todo o sistema: sem ele, o
 * detector de maior valor do VETO nao existe. Um endereco que aparece so num
 * chunk `retrieved` e a impressao digital de prompt injection indireta.
 *
 * Tudo aqui e ENTRADA NAO CONFIAVEL. Vem do processo do cliente, nao do
 * VETO, e por isso cada tipo tem schema Zod: se `provenance` chegar errado, a
 * verificacao de proveniencia degrada em silencio -- que e o pior modo de
 * falha possivel para este projeto.
 *
 * A origem NUNCA e declarada pelo agente. Ela e atribuida pela instrumentacao
 * do VETO no momento em que cada conteudo entra no runtime. O agente nao e
 * fonte confiavel sobre a propria decisao.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";

/** De onde veio um pedaco de contexto. Fechado. */
export const esquemaProveniencia = z.enum([
  "user", // digitado pelo usuario humano
  "system", // system prompt, sob controle do operador
  "retrieved", // RAG, pagina web, documento buscado
  "memory", // memoria persistida do agente
  "tool_output", // retorno de ferramenta
]);
export type Provenance = z.infer<typeof esquemaProveniencia>;

/**
 * Nivel de confianca por fonte, configurado pelo cliente no onboarding.
 *
 * Existe para conter a maior fonte de falso positivo do sistema: nem todo
 * conteudo recuperado e hostil. Um agente que consulta a API de roteamento de
 * uma DEX recebe enderecos legitimos que nao estavam no objetivo do usuario.
 * Tratar todo `tool_output` como hostil faria o cliente desligar o alerta.
 *
 * O padrao para fonte NAO configurada e `untrusted` -- degradar, nao liberar.
 */
export const esquemaNivelDeConfianca = z.enum(["trusted", "semi", "untrusted"]);
export type TrustLevel = z.infer<typeof esquemaNivelDeConfianca>;

export const esquemaConfiancaDeFonte = z.object({
  /** Dominio, nome de ferramenta ou chave de memoria. */
  pattern: z.string().min(1),
  level: esquemaNivelDeConfianca,
});
export type SourceTrust = z.infer<typeof esquemaConfiancaDeFonte>;

/** Um pedaco de contexto que entrou no modelo, com a origem atribuida. */
export const esquemaChunkDeContexto = z.object({
  text: z.string(),
  provenance: esquemaProveniencia,
  /** url, id de documento ou chave de memoria. Casa com SourceTrust.pattern. */
  source: z.string().optional(),
});
export type ContextChunk = z.infer<typeof esquemaChunkDeContexto>;

/** A chamada de ferramenta emitida pelo agente: o nivel 2, ja estruturado. */
export const esquemaToolCall = z.object({
  name: z.string().min(1),
  /** Valores contra os quais os placeholders `arg:` do manifesto resolvem. */
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof esquemaToolCall>;

/**
 * Tudo que o VETO recebe sobre uma acao, antes de avaliar.
 *
 * A transacao entra como objeto ja desserializado. A fronteira do SDK (formato
 * de fio, base64) e problema da camada de captura, nao deste contrato.
 */
export const esquemaActionContext = z.object({
  actionId: z.string().min(1),
  agentId: z.string().min(1),
  taskId: z.string().min(1).optional(),

  /** O que o humano pediu. Nivel 1, ambiguo por natureza. */
  userGoal: z.string(),
  systemPrompt: z.string(),

  /** Tudo que entrou no contexto do modelo, cada pedaco com sua origem. */
  contextChunks: z.array(esquemaChunkDeContexto),
  toolCall: esquemaToolCall,

  unsignedTx: z.instanceof(VersionedTransaction),
  /** Milissegundos desde a epoca. */
  timestamp: z.number().int().nonnegative(),
});
export type ActionContext = z.infer<typeof esquemaActionContext>;

/**
 * Confianca de uma fonte, com `untrusted` como padrao para o que nao foi
 * configurado. Primeiro padrao que casa vence, entao a ordem da lista importa.
 *
 * LIMITACAO CONHECIDA: o casamento e por substring. Um atacante que controla
 * "https://malicioso.xyz/?ref=quote-api.jup.ag" seria tratado como `trusted`
 * se esse padrao estiver configurado. Endurecer para comparacao por hostname
 * (com sufixo de dominio) quando o detector de proveniencia for construido --
 * ate la, a configuracao do cliente precisa usar padroes especificos.
 */
export function confiancaDaFonte(
  source: string | undefined,
  configurado: readonly SourceTrust[],
): TrustLevel {
  if (source === undefined) return "untrusted";
  const casou = configurado.find((c) => source.includes(c.pattern));
  return casou?.level ?? "untrusted";
}

/**
 * Se um chunk pode ser usado para explicar a origem de um endereco.
 *
 * `user` e `system` sao confiaveis por construcao. Os outros tres so contam
 * quando a fonte foi explicitamente marcada como `trusted` pelo cliente.
 */
export function chunkEhConfiavel(chunk: ContextChunk, configurado: readonly SourceTrust[]): boolean {
  switch (chunk.provenance) {
    case "user":
    case "system":
      return true;
    case "retrieved":
    case "memory":
    case "tool_output":
      return confiancaDaFonte(chunk.source, configurado) === "trusted";
  }
}
