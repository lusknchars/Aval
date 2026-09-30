/**
 * The verdict in plain Portuguese, derived from the findings.
 *
 * A TABLE, not a model. The spec allows an LLM to explain an alert after the
 * decision, and for this it would be the wrong tool anyway: a sentence
 * generated at display time can drift from the rule that actually decided,
 * and the one thing this page promises is that what you read is what the code
 * did. A table cannot drift.
 *
 * It is also why the phrases talk about the RULE rather than about intent.
 * "The address that receives this appears nowhere in what the user said" is
 * something the code checked. "This is a scam" is not.
 */
import { formatRawAmount, UNLIMITED_ALLOWANCE } from "../normalization/spl.js";
import { PROGRAM_NAMES } from "./recent.js";
import type { Trace, TraceEffect } from "./trace.js";

/** Authority kinds as a person would say them. */
const AUTHORITY_PT: Readonly<Record<string, string>> = {
  mint: "emissão",
  freeze: "congelamento",
  upgrade: "atualização do programa",
  close: "fechamento",
  staker: "stake (quem delega)",
  withdrawer: "saque do stake",
  custodian: "custódia do lockup",
  transfer_hook: "programa que roda em toda transferência",
};

const EFFECT_PT: Readonly<Record<string, string>> = {
  BALANCE_DECREASE: "saída de saldo",
  BALANCE_INCREASE: "entrada de saldo",
  DELEGATE_GRANT: "concessão de procuração sobre os tokens",
  AUTHORITY_CHANGE: "troca de autoridade",
  OWNER_CHANGE: "troca de dono da conta",
  ACCOUNT_CREATE: "criação de conta",
  ACCOUNT_CLOSE: "fechamento de conta",
  ACCOUNT_FREEZE: "congelamento da conta",
  PROGRAM_INVOKE: "chamada de programa",
};

/** Plain sentences for the fixed rules. Dynamic ones are handled below. */
const PHRASES: Readonly<Record<string, string>> = {
  "provenance.unexplained":
    "O endereço que recebe algo não aparece em nada que o usuário escreveu, nem em nada que o agente leu. Ele surgiu de um lugar que o VETO não observa.",
  "provenance.untrusted_source":
    "O endereço que recebe algo só aparece em conteúdo que o agente leu de uma fonte não confiável — é a forma clássica de prompt injection: a página escolhe o destino.",
  "provenance.known_counterparty":
    "O endereço já foi usado antes por este agente, mas não foi pedido agora.",
  "provenance.trusted_source":
    "O endereço veio de uma fonte que o cliente marcou como confiável, e não do pedido do usuário.",

  "magnitude.above_declared":
    "A transação move mais do que a chamada da ferramenta declarou.",
  "magnitude.fee_above_ceiling":
    "A taxa de rede está acima do teto. Taxa alta é SOL saindo da carteira que nenhum manifesto limita.",

  "always_critical.unlimited_delegate":
    "Alguém recebeu procuração ILIMITADA sobre os tokens: pode mover o saldo inteiro, quando quiser, para sempre.",
  "always_critical.authority_change":
    "Uma autoridade mudou de mãos. Isso não acontece por acidente.",
  "always_critical.owner_change":
    "O dono da conta mudou. A conta deixou de ser de quem era.",
  "always_critical.account_frozen":
    "A conta foi congelada: o dono não consegue mais mover nada dela. Nenhum token se moveu, então nenhuma checagem de valor veria isso.",

  "undeclared.program_not_allowed":
    "A transação chama um programa que o manifesto da ferramenta não permite.",

  "coverage.no_manifest":
    "Não existe manifesto para esta ferramenta, então não deu para comparar o que ela prometeu com o que a transação faz. Continuam valendo a rede de segurança e a proveniência.",
  "coverage.simulation_unavailable":
    "Não foi possível simular. Sem simulação não há como saber o que a transação faz, e falta de informação nunca vira liberação.",
  "coverage.transaction_would_fail":
    "A transação falharia se fosse enviada agora. Ela não causa nada.",
  "coverage.manifest_not_compared":
    "Como nada executou, não havia efeito para comparar com o manifesto.",
  "coverage.manifest_invalid":
    "O manifesto desta ferramenta tem um problema de escrita, então parte das checagens não roda.",
  "coverage.unresolved_reference":
    "O manifesto aponta para um argumento que a chamada não enviou, então essa comparação não rodou.",
  "coverage.token_extensions":
    "A conta usa extensões do Token-2022 que o VETO não lê — pode haver um transfer hook ou um delegado permanente ali, e nada disso apareceria como efeito.",
  "coverage.undecoded_authority_account":
    "Uma conta de stake ou de programa atualizável mudou, e o VETO não decodifica esses bytes. Uma autoridade pode ter mudado sem aparecer.",
  "coverage.undecodable_token_account":
    "Uma conta de token não pôde ser lida, então qualquer movimento dentro dela é invisível.",
  "coverage.account_limit_exceeded":
    "A transação mexe em mais contas do que uma simulação devolve. O que acontece nas contas restantes não foi observado.",
  "coverage.unresolved_lookup_table":
    "Uma lookup table não pôde ser lida, então parte dos endereços da transação é desconhecida.",
  "coverage.inexact_lamports":
    "Um saldo chegou arredondado do RPC, então valores derivados dele são aproximados.",
  "coverage.accounts_unobserved":
    "Nem toda conta citada foi observada — normal para contas somente-leitura, que não mudam de estado.",
  "coverage.baseline_slot_gap":
    "Os dois lados da comparação vieram de momentos ligeiramente diferentes da cadeia.",
};

function phraseFor(
  rule: string,
  detail: Readonly<Record<string, unknown>>,
  decimals: ReadonlyMap<string, number>,
): string {
  // The concrete numbers, where the finding carries them. "It moves more than
  // declared" is an assertion; "you asked for 100 and it moves 500" is
  // evidence, and evidence is what somebody needs to decide.
  if (rule === "magnitude.above_declared") {
    const mint = typeof detail["mint"] === "string" ? detail["mint"] : null;
    const declared = typeof detail["declared"] === "string" ? detail["declared"] : null;
    const observed = typeof detail["observed"] === "string" ? detail["observed"] : null;
    const unlimited =
      observed !== null && BigInt(observed) >= UNLIMITED_ALLOWANCE;
    return unlimited
      ? `Você pediu ${money(declared, mint, decimals)} e a transação dá acesso ILIMITADO — o saldo inteiro, para sempre.`
      : `Você pediu ${money(declared, mint, decimals)} e a transação move ${money(observed, mint, decimals)}.`;
  }
  if (rule === "magnitude.fee_above_ceiling") {
    const fee = typeof detail["fee"] === "string" ? detail["fee"] : "?";
    const ceiling = typeof detail["ceiling"] === "string" ? detail["ceiling"] : "?";
    return `A taxa de rede é ${money(fee, "SOL", decimals)}, acima do teto de ${money(ceiling, "SOL", decimals)}. Taxa alta é SOL saindo da carteira que nenhum manifesto limita.`;
  }
  if (rule === "provenance.unexplained" || rule === "provenance.untrusted_source") {
    const who = typeof detail["counterparty"] === "string" ? detail["counterparty"] : "?";
    const base = PHRASES[rule] ?? rule;
    return `${base}\n${who}`;
  }
  if (rule === "always_critical.unlimited_delegate") {
    const who = typeof detail["delegate"] === "string" ? detail["delegate"] : "?";
    return `${PHRASES[rule] ?? rule}\nQuem recebeu: ${who}`;
  }
  const fixed = PHRASES[rule];
  if (fixed !== undefined) return fixed;
  if (rule.startsWith("mustNot.")) {
    const effect = EFFECT_PT[rule.slice("mustNot.".length)] ?? rule;
    return `A ferramenta chamada nunca pode causar ${effect}, e a transação causa.`;
  }
  if (rule.startsWith("undeclared.")) {
    const effect = EFFECT_PT[rule.slice("undeclared.".length)] ?? rule;
    return `A transação causa ${effect} que a chamada da ferramenta não declarou.`;
  }
  if (rule.startsWith("must.missing.")) {
    const effect = EFFECT_PT[rule.slice("must.missing.".length)] ?? rule;
    return `A ferramenta prometeu ${effect} e a transação não faz isso.`;
  }
  if (rule.startsWith("scope.outside_")) {
    return "A transação mexe numa conta que o pedido nunca nomeou.";
  }
  return rule;
}

const SOL_DECIMALS = 9;

function short(address: string): string {
  return address.length > 14
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

/**
 * An amount in the unit a human reads.
 *
 * Without the mint's decimals a raw number is meaningless -- 51000000 could be
 * 51 USDC or 0.051 SOL -- so when they are unknown the raw value is shown as
 * raw, labelled, rather than dressed up as something it is not.
 */
function money(
  raw: string | null,
  mint: string | null,
  decimals: ReadonlyMap<string, number>,
): string {
  if (raw === null) return "";
  if (mint === "SOL") return `${formatRawAmount(BigInt(raw), SOL_DECIMALS)} SOL`;
  const places = mint === null ? undefined : decimals.get(mint);
  if (places === undefined) return `${raw} (unidades cruas de ${short(mint ?? "?")})`;
  return `${formatRawAmount(BigInt(raw), places)} ${short(mint ?? "?")}`;
}

/** One effect, in a sentence somebody who does not know Solana can read. */
function describeEffect(
  e: TraceEffect,
  decimals: ReadonlyMap<string, number>,
): string {
  const value = money(e.amount, e.mint, decimals);
  switch (e.type) {
    case "BALANCE_DECREASE":
      return `saem ${value} de ${short(e.account)}`;
    case "BALANCE_INCREASE":
      return `entram ${value} em ${short(e.account)}${e.counterparty === null ? "" : `, que é de ${short(e.counterparty)}`}`;
    case "DELEGATE_GRANT": {
      const unlimited =
        e.amount !== null && BigInt(e.amount) >= UNLIMITED_ALLOWANCE;
      return unlimited
        ? `${short(e.counterparty ?? "?")} ganha procuração ILIMITADA sobre os tokens de ${short(e.account)}`
        : `${short(e.counterparty ?? "?")} ganha procuração de ${value} sobre ${short(e.account)}`;
    }
    case "AUTHORITY_CHANGE":
      return `a autoridade de ${AUTHORITY_PT[e.authorityKind ?? ""] ?? e.authorityKind ?? "?"} de ${short(e.account)} passa para ${e.counterparty === null ? "ninguém" : short(e.counterparty)}`;
    case "OWNER_CHANGE":
      return `${short(e.account)} muda de dono para ${short(e.counterparty ?? "?")}`;
    case "ACCOUNT_CREATE":
      return `cria a conta ${short(e.account)}`;
    case "ACCOUNT_CLOSE":
      return `fecha a conta ${short(e.account)}`;
    case "ACCOUNT_FREEZE":
      return `congela ${short(e.account)}: o dono não move mais nada dela`;
    case "PROGRAM_INVOKE": {
      const id = e.program ?? e.account;
      // A name where we have one. "chama o Compute Budget" is a sentence;
      // "chama o programa Comput…1111" is a riddle.
      return `chama o ${PROGRAM_NAMES.get(id) ?? `programa ${short(id)}`}`;
    }
    default:
      return e.type;
  }
}

/** What the tool call SAID it would do, in the same voice. */
function describeAsk(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const a = (k: string): string => {
    const v = args[k];
    return typeof v === "string" ? short(v) : typeof v === "number" ? String(v) : "?";
  };
  const raw = (k: string): string => {
    const v = args[k];
    return typeof v === "string" || typeof v === "number" ? String(v) : "?";
  };
  switch (tool) {
    case "transfer_sol":
      return `enviar ${raw("amount")} lamports de ${a("from")} para ${a("to")}`;
    case "transfer_token":
      return `enviar ${raw("amount")} do token ${a("mint")} de ${a("from")} para ${a("to")}`;
    case "approve":
      return `dar procuração de ${raw("amount")} do token ${a("mint")} para ${a("delegate")}`;
    case "swap":
      return `trocar ${raw("amountIn")} do token ${a("mint")}`;
    case "close_account":
      return `fechar a conta ${a("account")} e mandar o saldo para ${a("destination")}`;
    case "revoke":
      return `tirar a procuração da conta ${a("account")}`;
    default:
      return "nada foi declarado — não existe manifesto para esta ferramenta";
  }
}

/**
 * Three things were being printed under one heading, and they are not alike.
 *
 * "I could not READ this" is a limitation of the tool. "Nobody DECLARED
 * anything to compare against" is a property of the input -- a market-making
 * bot never told anyone what it was going to do, and no amount of better
 * reading fixes that. "This transaction would fail" is a fact about the
 * transaction. Printing all three as "could not check" made the tool look
 * blind when it had read everything perfectly.
 */
const NOTHING_TO_COMPARE: ReadonlySet<string> = new Set([
  "coverage.no_manifest",
  "coverage.manifest_not_compared",
  "coverage.unresolved_reference",
  "coverage.manifest_invalid",
]);

const ABOUT_THE_TRANSACTION: ReadonlySet<string> = new Set([
  "coverage.transaction_would_fail",
]);

export function groupOf(
  rule: string,
  check: string,
): "does" | "compare" | "read" {
  if (check !== "coverage") return "does";
  if (ABOUT_THE_TRANSACTION.has(rule)) return "does";
  return NOTHING_TO_COMPARE.has(rule) ? "compare" : "read";
}

export interface Explanation {
  /**
   * Whether there is an agent behind this transaction at all.
   *
   * VETO is a COMPARATOR: it holds a declaration against an execution. A
   * transaction pulled off a live block has no declaration, no tool call and
   * no user -- so allow/flag/deny is an answer to a question nobody asked,
   * and showing it as a judgement is the demo misrepresenting the library.
   * In production this never happens: a customer's agent always emits a tool
   * call, even when no manifest covers it.
   */
  readonly unattributed: boolean;
  /** Level 1: everything the agent had in front of it, and where it came from. */
  readonly received: readonly { readonly text: string; readonly origin: string }[];
  readonly verdict: string;
  readonly summary: string;
  /** What the tool call promised, in plain Portuguese. */
  readonly asked: string;
  /** What the transaction would actually do, one line each. */
  readonly does: readonly string[];
  /** What actually moved the decision. */
  readonly reasons: readonly string[];
  /** Reported, but not enough to change anything on its own. */
  readonly minor: readonly string[];
}

/**
 * What the transaction does -- or why that is not knowable.
 *
 * An empty effect list has two completely different causes and they must never
 * read the same. "It causes nothing" is a fact about the transaction. "The
 * simulation failed, so there is no post-state to read" is a fact about our
 * visibility, and writing it as the first one is the precise mistake the
 * `SimulationOutcome` union exists to prevent.
 */
function describeWhatHappens(
  trace: Trace,
  decimals: ReadonlyMap<string, number>,
): readonly string[] {
  if (trace.effects.length > 0)
    return trace.effects.map((e) => describeEffect(e, decimals));

  // The chain already answered. Re-simulating a transaction that landed
  // usually fails, and refusing to show what it did would be pedantry: the
  // record exists, it just is not a prediction, so it is labelled as history.
  const history = trace.history;
  if (history !== null && history.lines.length > 0) {
    return [
      `— o que ela FEZ quando entrou no slot ${history.slot}, lido do bloco —`,
      ...history.lines,
    ];
  }

  const detail = trace.transaction.simulationDetail;
  if (trace.transaction.simulation === "failed") {
    return [
      `não dá para saber — enviada agora, esta transação FALHARIA${detail === null ? "" : ` (${detail})`}, e uma transação que falha não tem estado posterior para ler`,
    ];
  }
  if (trace.transaction.simulation === "unavailable") {
    return [
      `não dá para saber — não foi possível simular${detail === null ? "" : `: ${detail}`}`,
    ];
  }
  return ["nada — a transação rodou e não causaria efeito nenhum"];
}

export function explainInPortuguese(
  trace: Trace,
  decimals: ReadonlyMap<string, number> = new Map(),
): Explanation {
  const findings = trace.findings;
  const deciding = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  );
  const medium = findings.filter((f) => f.severity === "medium");
  const low = findings.filter((f) => f.severity === "low");

  const moved = deciding.length > 0 ? deciding : medium;
  const rest = deciding.length > 0 ? [...medium, ...low] : low;

  const accusations = moved.filter((f) => groupOf(f.rule, f.check) === "does");
  const onlyGaps = accusations.length === 0;
  // "Nothing was declared" is not the same as "I could not see". Saying which
  // one happened is the difference between a tool that looks broken and a
  // tool that is telling you something true about its input.
  const onlyMissingDeclaration =
    onlyGaps && moved.every((f) => groupOf(f.rule, f.check) === "compare");

  // A fact the pipeline knows, not a guess about the transaction.
  const unattributed = trace.declarationSource !== "agent";
  const reconstructed = trace.declarationSource === "reconstructed";

  const verdict = unattributed
    ? reconstructed
      ? "DECLARAÇÃO RECONSTRUÍDA — VEREDITO PARCIAL"
      : trace.declarationSource === "none"
        ? "SEM DECLARAÇÃO — NÃO DÁ PARA DAR VEREDITO"
        : "DECLARAÇÃO ESCRITA À MÃO"
    : trace.decision.outcome === "deny"
      ? "BLOQUEADO"
      : trace.decision.outcome === "flag"
        ? "PRECISA DE OLHO HUMANO"
        : "LIBERADO";

  let summary: string;
  if (reconstructed) {
    summary =
      "Esta transação não tem agente por trás: ela veio de um bloco da rede, e a declaração abaixo fui EU que li de volta dos próprios efeitos dela. Por isso os checks de efeito não declarado e de magnitude não valem nada aqui — é claro que a transação faz o que a declaração diz, se a declaração foi copiada dela. O que continua valendo é a proveniência e a rede de segurança, que não dependem de declaração nenhuma.";
  } else if (trace.declarationSource === "none") {
    summary =
      "Esta transação não tem agente por trás e não deu para reconhecer que operação ela é. O VETO compara o que foi PROMETIDO com o que a transação FAZ, e aqui ninguém prometeu nada. Isso não é falha da ferramenta nem defeito da transação: é a pergunta não se aplicar.";
  } else if (unattributed) {
    summary =
      "A declaração abaixo foi escrita à mão, não emitida por um modelo. Serve para explorar o comportamento do VETO; não é um trace de agente de verdade.";
  } else if (trace.decision.outcome === "allow") {
    summary =
      "Tudo que a transação faz bate com o que foi pedido, e todo mundo que recebe algo foi explicado por alguma coisa que o usuário disse.";
  } else if (onlyMissingDeclaration) {
    summary =
      "O VETO leu a transação inteira, sem falha nenhuma. O que falta não é leitura: é DECLARAÇÃO. Ninguém disse o que esta operação deveria fazer, então não há com o que comparar. Um bot de mercado não declara nada a ninguém — e sem declaração o VETO não assina embaixo.";
  } else if (onlyGaps) {
    summary =
      "Nada na transação contradiz o pedido. O que aconteceu foi o VETO não conseguir ler alguma coisa — e quando ele não enxerga, ele fecha em vez de abrir. Isso não é uma acusação.";
  } else if (trace.decision.outcome === "deny") {
    summary =
      "A transação faz algo que o pedido não explica, e o VETO recusou assinar.";
  } else {
    summary =
      "A transação faz algo que vale um humano olhar antes de assinar.";
  }

  return {
    verdict,
    summary,
    unattributed,
    received: trace.input.chunks.map((c) => ({
      text: c.text,
      origin:
        c.provenance === "user"
          ? "o usuário escreveu"
          : `o agente leu${c.source === null ? "" : ` de ${c.source}`}${c.trusted ? "" : " — fonte NÃO confiável"}`,
    })),
    asked: unattributed
      ? "nada — esta transação veio de um bloco da rede, não de um agente"
      : describeAsk(trace.toolCall.name, trace.toolCall.args),
    does: describeWhatHappens(trace, decimals),
    reasons: moved.map((f) => phraseFor(f.rule, f.detail, decimals)),
    minor: rest.map((f) => phraseFor(f.rule, f.detail, decimals)),
  };
}
