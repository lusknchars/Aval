/**
 * Script de exploracao: SIMULA uma transferencia de lamports em devnet e pede
 * ao RPC o estado pos-simulacao da origem e do destino (opcao `accounts`).
 *
 *   pnpm exec tsx --env-file=.env test/exploracao/simular-transferencia.ts <endereco-origem> [lamports]
 *
 * lamports e opcional (padrao 1). O destino e sempre um endereco aleatorio sem
 * conta, entao abaixo do minimo rent-exempt a simulacao deve falhar por rent.
 *
 * Nao assina validamente, nao envia, nao confirma. A origem e marcada como
 * signer na mensagem, mas a assinatura e um placeholder de 64 bytes zerados e
 * a simulacao roda com sigVerify: false. Essa tx NAO poderia ser enviada.
 *
 * Codigos de saida:
 *   0  simulacao executada, err = null, estados coerentes com o experimento
 *   1  entrada ou configuracao invalida (inclui RPC que nao e devnet e lamports invalido)
 *   2  conta de origem nao existe
 *   3  conta de origem inadequada (executavel ou owner != System Program)
 *   4  saldo insuficiente para lamports + taxa
 *   5  falha de transporte ou RPC (inclui leitura anterior)
 *   6  simulacao executada, err preenchido (a tx FALHARIA)
 *   7  resposta estruturalmente inconsistente (sem accounts, contagem, encoding)
 *   8  estrutura ok, mas uma verificacao de sanidade do experimento falhou
 */
import { randomBytes } from "node:crypto";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Commitment,
  type SimulatedTransactionAccountInfo,
} from "@solana/web3.js";
import { z } from "zod";

const GENESIS_DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const QUANTIDADE_PADRAO = 1n;
// SystemProgram.transfer codifica lamports como u64 (getU64Codec no SDK instalado).
const U64_MAX = 2n ** 64n - 1n;
const MAX_LOGS = 30;
const MAX_BASE64_CHARS = 64;
const ROTULOS = ["origem", "destino"];

const EXIT_OK = 0;
const EXIT_ENTRADA = 1;
const EXIT_INEXISTENTE = 2;
const EXIT_INADEQUADA = 3;
const EXIT_SALDO = 4;
const EXIT_RPC = 5;
const EXIT_SIMULACAO_FALHOU = 6;
const EXIT_RESPOSTA_INCONSISTENTE = 7;
const EXIT_SANIDADE = 8;

const esquemaUrl = z.url({ protocol: /^https?$/ });
const esquemaCommitment = z.enum(["processed", "confirmed", "finalized"]);

type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };
type Config = { rpcUrl: string; commitment: Commitment };
type Entrada = { origem: PublicKey; lamports: bigint };

/** Visao comum para estado on-chain (AccountInfo) e pos-simulacao. */
type Estado = {
  lamports: number;
  owner: string;
  executable: boolean;
  rentEpoch: number | null;
  dados: Buffer;
};

// ---------------------------------------------------------------- entrada

function lerConfig(env: NodeJS.ProcessEnv): Resultado<Config> {
  const url = env["VETO_RPC_URL_DEVNET"];
  if (url === undefined || url === "") {
    return { ok: false, erro: "VETO_RPC_URL_DEVNET nao definida. Preencha no .env." };
  }
  if (!esquemaUrl.safeParse(url).success) {
    return { ok: false, erro: "VETO_RPC_URL_DEVNET nao e uma URL http(s) valida." };
  }
  const commitment = esquemaCommitment.safeParse(env["VETO_RPC_COMMITMENT"]);
  if (!commitment.success) {
    return {
      ok: false,
      erro: "VETO_RPC_COMMITMENT ausente ou invalido. Use processed, confirmed ou finalized.",
    };
  }
  return { ok: true, valor: { rpcUrl: url, commitment: commitment.data } };
}

// String -> bigint direto, sem passar por number: nada de perda de precisao.
function lerLamports(texto: string | undefined): Resultado<bigint> {
  if (texto === undefined) return { ok: true, valor: QUANTIDADE_PADRAO };
  // So digitos: rejeita "-5", "1.5", "1e3", "+1", " 1", "0x10".
  if (!/^[0-9]+$/.test(texto)) {
    return { ok: false, erro: `Lamports invalido: "${texto}" nao e um inteiro positivo em decimal.` };
  }
  const valor = BigInt(texto);
  if (valor === 0n) return { ok: false, erro: "Lamports invalido: precisa ser maior que zero." };
  if (valor > U64_MAX) return { ok: false, erro: `Lamports invalido: acima de u64 (${U64_MAX}).` };
  return { ok: true, valor };
}

function lerEntrada(argv: readonly string[]): Resultado<Entrada> {
  const endereco = argv[2];
  if (endereco === undefined || argv.length > 4) {
    return { ok: false, erro: "Uso: simular-transferencia.ts <endereco-origem-base58> [lamports]" };
  }
  let origem: PublicKey;
  try {
    origem = new PublicKey(endereco);
  } catch {
    return { ok: false, erro: `Endereco invalido: "${endereco}" nao e uma chave publica base58 de 32 bytes.` };
  }
  const lamports = lerLamports(argv[3]);
  if (!lamports.ok) return lamports;
  return { ok: true, valor: { origem, lamports: lamports.valor } };
}

// Erro do SDK pode citar a URL. Apaga a URL inteira e qualquer api-key.
function redigir(texto: string, rpcUrl: string): string {
  return texto
    .split(rpcUrl)
    .join("<rpc-devnet>")
    .replace(/api-key=[^&\s"']+/gi, "api-key=***");
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

// ---------------------------------------------------------------- estados

function estadoOnChain(info: AccountInfo<Buffer>): Estado {
  return {
    lamports: info.lamports,
    owner: info.owner.toBase58(),
    executable: info.executable,
    rentEpoch: info.rentEpoch ?? null,
    dados: info.data,
  };
}

/** Pos-estado: data deve vir como ["<base64>", "base64"]. Qualquer outra forma e rejeitada. */
function estadoSimulado(info: SimulatedTransactionAccountInfo): Resultado<Estado> {
  const [conteudo, encoding, ...resto] = info.data;
  if (conteudo === undefined || encoding !== "base64" || resto.length > 0) {
    return { ok: false, erro: `data com formato/encoding inesperado: ${JSON.stringify(info.data).slice(0, 80)}` };
  }
  const dados = Buffer.from(conteudo, "base64");
  // Buffer.from ignora caracteres invalidos em silencio; o round-trip pega isso.
  if (dados.toString("base64") !== conteudo) {
    return { ok: false, erro: "data nao e base64 canonico" };
  }
  return {
    ok: true,
    valor: {
      lamports: info.lamports,
      owner: info.owner,
      executable: info.executable,
      rentEpoch: info.rentEpoch ?? null,
      dados,
    },
  };
}

function formatarRentEpoch(v: number | null): string {
  if (v === null) return "nao retornado";
  // rentEpoch e u64. Acima de 2^53 o JSON.parse ja arredondou; o original se perdeu.
  return Number.isSafeInteger(v) ? String(v) : `${v}  (acima de 2^53-1: chegou arredondado, u64 original nao recuperavel)`;
}

function imprimirEstado(recuo: string, estado: Estado | null, seAusente: string): void {
  if (estado === null) {
    console.log(`${recuo}${seAusente}`);
    return;
  }
  const b64 = estado.dados.toString("base64");
  const corpo =
    b64.length === 0
      ? "(vazio)"
      : b64.length > MAX_BASE64_CHARS
        ? `${b64.slice(0, MAX_BASE64_CHARS)}... (truncado: ${b64.length - MAX_BASE64_CHARS} chars omitidos)`
        : b64;
  console.log(`${recuo}lamports:   ${estado.lamports}`);
  console.log(`${recuo}owner:      ${estado.owner}`);
  console.log(`${recuo}executable: ${estado.executable}`);
  console.log(`${recuo}rentEpoch:  ${formatarRentEpoch(estado.rentEpoch)}`);
  console.log(`${recuo}data:       ${estado.dados.length} bytes, base64 ${corpo}`);
}

// lamports chega como number. bigint so e exato se o number for inteiro seguro.
function paraBigint(n: number): bigint | null {
  return Number.isSafeInteger(n) ? BigInt(n) : null;
}

function diferenca(antes: number, depois: number): string {
  const a = paraBigint(antes);
  const d = paraBigint(depois);
  if (a === null || d === null) return "imprecisa (valor acima de 2^53-1)";
  const x = d - a;
  return x > 0n ? `+${x}` : `${x}`;
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const config = lerConfig(process.env);
  if (!config.ok) {
    console.error(config.erro);
    return EXIT_ENTRADA;
  }
  const entrada = lerEntrada(process.argv);
  if (!entrada.ok) {
    console.error(entrada.erro);
    return EXIT_ENTRADA;
  }
  const { origem, lamports } = entrada.valor;
  const { rpcUrl, commitment } = config.valor;
  const conexao = new Connection(rpcUrl, { commitment, disableRetryOnRateLimit: true });
  const falhaRpc = (etapa: string, erro: unknown): number => {
    console.error(`Falha de RPC (${etapa}): ${redigir(mensagemDe(erro), rpcUrl)}`);
    return EXIT_RPC;
  };

  // --- rede
  try {
    if ((await conexao.getGenesisHash()) !== GENESIS_DEVNET) {
      console.error("VETO_RPC_URL_DEVNET respondeu, mas nao e devnet (genesis hash diferente). Recusado.");
      return EXIT_ENTRADA;
    }
  } catch (erro) {
    return falhaRpc("getGenesisHash", erro);
  }

  // Destino: 32 bytes aleatorios. Nao existe chave privada correspondente conhecida.
  const destino = new PublicKey(randomBytes(32));
  // Ordem fixa usada em TODAS as chamadas: indice 0 = origem, indice 1 = destino.
  const enderecos = [origem, destino];

  // --- leitura ANTES: as duas contas numa unica chamada, com context.slot
  let antes: Awaited<ReturnType<Connection["getMultipleAccountsInfoAndContext"]>>;
  try {
    antes = await conexao.getMultipleAccountsInfoAndContext(enderecos, { commitment });
  } catch (erro) {
    return falhaRpc("leitura anterior de origem+destino", erro);
  }
  if (antes.value.length !== enderecos.length) {
    console.error(`Leitura anterior devolveu ${antes.value.length} contas para ${enderecos.length} pedidas.`);
    return EXIT_RESPOSTA_INCONSISTENTE;
  }
  const origemAntesInfo = antes.value[0] ?? null;
  const destinoAntesInfo = antes.value[1] ?? null;

  if (origemAntesInfo === null) {
    console.error(`Conta de origem nao existe em devnet (commitment ${commitment}): ${origem.toBase58()}`);
    return EXIT_INEXISTENTE;
  }
  if (origemAntesInfo.executable) {
    console.error("Conta de origem inadequada: e executavel (programa), nao carteira.");
    return EXIT_INADEQUADA;
  }
  if (!origemAntesInfo.owner.equals(SystemProgram.programId)) {
    console.error(
      `Conta de origem inadequada: owner ${origemAntesInfo.owner.toBase58()} nao e o System Program; ` +
        "SystemProgram.transfer so debita contas do System Program.",
    );
    return EXIT_INADEQUADA;
  }
  if (destinoAntesInfo !== null) {
    console.error(`Destino aleatorio ${destino.toBase58()} ja existe on-chain; premissa do experimento quebrada.`);
    return EXIT_SANIDADE;
  }
  const estadosAntes = [estadoOnChain(origemAntesInfo), null];

  // --- montagem
  const instrucao = SystemProgram.transfer({
    fromPubkey: origem, // entra como isSigner: true, isWritable: true
    toPubkey: destino,
    lamports, // bigint: o SDK aceita number | bigint e codifica como u64
  });

  let blockhash: string;
  try {
    blockhash = (await conexao.getLatestBlockhash(commitment)).blockhash;
  } catch (erro) {
    return falhaRpc("getLatestBlockhash", erro);
  }

  // payerKey = origem: vira indice 0, fee payer e signer (numRequiredSignatures = 1).
  const mensagem = new TransactionMessage({
    payerKey: origem,
    recentBlockhash: blockhash,
    instructions: [instrucao],
  }).compileToV0Message();
  // Sem .sign(): o SDK preenche cada assinatura exigida com 64 bytes zerados.
  const tx = new VersionedTransaction(mensagem);
  const placeholderZerado = tx.signatures.every((s) => s.every((b) => b === 0));

  let taxa: number | null;
  try {
    taxa = (await conexao.getFeeForMessage(mensagem, commitment)).value;
  } catch (erro) {
    return falhaRpc("getFeeForMessage", erro);
  }
  if (taxa === null) {
    console.error("RPC nao estimou a taxa (blockhash expirado?). Saldo nao pode ser verificado; experimento recusado.");
    return EXIT_RPC;
  }

  let minimoRent: number;
  try {
    minimoRent = await conexao.getMinimumBalanceForRentExemption(0, commitment);
  } catch (erro) {
    return falhaRpc("getMinimumBalanceForRentExemption", erro);
  }

  // Comparacoes em bigint; se algum number nao for inteiro seguro, o experimento e recusado.
  const saldoAntes = paraBigint(origemAntesInfo.lamports);
  const taxaBig = paraBigint(taxa);
  const minimoBig = paraBigint(minimoRent);
  if (saldoAntes === null || taxaBig === null || minimoBig === null) {
    console.error("Saldo, taxa ou minimo de rent acima de 2^53-1: comparacao nao e confiavel; experimento recusado.");
    return EXIT_SALDO;
  }
  if (saldoAntes < lamports + taxaBig) {
    console.error(`Saldo insuficiente: ${origemAntesInfo.lamports} lamports < ${lamports} + taxa ${taxa}.`);
    return EXIT_SALDO;
  }

  console.log("== ANTES (estado on-chain atual) ==");
  console.log(`rede:             devnet (genesis conferido)`);
  console.log(`slot da leitura:  ${antes.context.slot}`);
  enderecos.forEach((pk, i) => {
    console.log(`  [${i}] ${ROTULOS[i]} ${pk.toBase58()}`);
    imprimirEstado("        ", estadosAntes[i] ?? null, "INEXISTENTE on-chain (getMultipleAccounts devolveu null)");
  });

  console.log("\n== TRANSACAO MONTADA (nao assinada validamente) ==");
  console.log(`destino temp.:    ${destino.toBase58()}  (32 bytes aleatorios, sem chave privada)`);
  console.log(`quantidade:       ${lamports} lamports`);
  console.log(`minimo rent-exempt (0 bytes, via RPC): ${minimoRent} lamports`);
  console.log(
    `abaixo do minimo: ${lamports < minimoBig ? "SIM" : "nao"}` +
      "  (so importa porque o destino e conta NOVA; para conta existente nao se aplica assim)",
  );
  console.log(`taxa estimada:    ${taxa} lamports`);
  console.log(`versao mensagem:  ${mensagem.version}`);
  console.log(`signers exigidos: ${mensagem.header.numRequiredSignatures} (indice 0 = ${mensagem.staticAccountKeys[0]?.toBase58() ?? "?"})`);
  console.log(`assinatura:       ${placeholderZerado ? "placeholder de 64 bytes zerados" : "NAO ZERADA -- inesperado"}`);

  // --- simulacao, pedindo o pos-estado exatamente de [origem, destino]
  // minContextSlot: a simulacao nao pode usar estado mais antigo que a leitura anterior.
  const minContextSlot = antes.context.slot;
  const enderecosPedidos = enderecos.map((pk) => pk.toBase58());
  let sim: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    sim = await conexao.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment,
      minContextSlot,
      accounts: { encoding: "base64", addresses: enderecosPedidos },
    });
  } catch (erro) {
    return falhaRpc("simulateTransaction", erro);
  }
  const r = sim.value;

  console.log("\n== SIMULACAO (simulateTransaction -- nada foi transmitido) ==");
  console.log(`minContextSlot:   ${minContextSlot}`);
  console.log(`slot da simulacao: ${sim.context.slot}`);
  console.log("sigVerify:        false");
  console.log("replaceRecentBlockhash: true");
  console.log(`accounts pedidas: ${enderecosPedidos.length} -> [0] origem, [1] destino`);
  console.log(`err:              ${r.err === null ? "null" : JSON.stringify(r.err)}`);
  console.log(`unitsConsumed:    ${r.unitsConsumed ?? "nao retornado"}`);
  // Campo real do RPC que o tipo do SDK nao declara; lido sem cast.
  const substituto = "replacementBlockhash" in r ? r.replacementBlockhash : undefined;
  console.log(`replacementBlockhash: ${substituto === undefined || substituto === null ? "nao retornado" : JSON.stringify(substituto)}`);
  if (r.returnData === undefined || r.returnData === null) {
    console.log("returnData:       nao retornado");
  } else {
    const bytes = Buffer.from(r.returnData.data[0], "base64").length;
    console.log(`returnData:       programa ${r.returnData.programId}, ${bytes} bytes`);
  }
  if (r.logs === null) {
    console.log("logs:             indisponiveis (RPC devolveu null)");
  } else {
    console.log(`logs (${r.logs.length}):`);
    for (const l of r.logs.slice(0, MAX_LOGS)) console.log(`  ${l}`);
    if (r.logs.length > MAX_LOGS) console.log(`  ... ${r.logs.length - MAX_LOGS} linha(s) omitida(s) pelo limite`);
  }

  // --- pos-estado simulado
  const falhou = r.err !== null;
  console.log(`\n== ESTADOS: ANTES (slot ${antes.context.slot}) vs POS-SIMULACAO (slot ${sim.context.slot}) ==`);
  if (falhou) {
    console.log("  ATENCAO: err != null. Qualquer pos-estado abaixo e HIPOTETICO de uma execucao");
    console.log("  que falharia; NAO e um estado final que poderia ser confirmado.");
  }
  const contas = r.accounts;
  if (contas === undefined || contas === null) {
    console.log("  RPC nao devolveu value.accounts.");
    if (falhou) return EXIT_SIMULACAO_FALHOU;
    console.error("Resposta inconsistente: pedimos accounts e a simulacao passou, mas o campo veio ausente.");
    return EXIT_RESPOSTA_INCONSISTENTE;
  }
  if (contas.length !== enderecosPedidos.length) {
    console.error(`Resposta inconsistente: ${contas.length} contas para ${enderecosPedidos.length} pedidas.`);
    return EXIT_RESPOSTA_INCONSISTENTE;
  }
  console.log("  (os itens de value.accounts NAO trazem endereco: associacao e so pela posicao)");

  const estadosPos: (Estado | null)[] = [];
  for (let i = 0; i < contas.length; i++) {
    const bruto = contas[i];
    if (bruto === undefined || bruto === null) {
      estadosPos.push(null);
      continue;
    }
    const e = estadoSimulado(bruto);
    if (!e.ok) {
      console.error(`Resposta inconsistente em accounts[${i}] (${ROTULOS[i]}): ${e.erro}`);
      return EXIT_RESPOSTA_INCONSISTENTE;
    }
    estadosPos.push(e.valor);
  }

  enderecos.forEach((pk, i) => {
    console.log(`  [${i}] ${ROTULOS[i]} ${pk.toBase58()}`);
    console.log("      antes:");
    imprimirEstado("        ", estadosAntes[i] ?? null, "inexistente");
    console.log(falhou ? "      pos-simulacao (HIPOTETICO, nao confirmavel):" : "      pos-simulacao:");
    imprimirEstado("        ", estadosPos[i] ?? null, "AUSENTE no retorno (null)");
  });

  // --- verificacoes de sanidade especificas deste experimento (nao e diff generico)
  const checagens: { ok: boolean; texto: string }[] = [];
  if (!falhou) {
    const origemPos = estadosPos[0] ?? null;
    const destinoPos = estadosPos[1] ?? null;
    checagens.push({ ok: enderecosPedidos.length === 2, texto: "exatamente 2 contas pedidas" });
    checagens.push({ ok: contas.length === 2, texto: "2 contas devolvidas, associadas por posicao" });
    checagens.push({ ok: true, texto: "origem existia antes" });
    checagens.push({ ok: destinoAntesInfo === null, texto: "destino inexistente antes" });
    checagens.push({ ok: destinoPos !== null, texto: "destino presente no pos-estado" });
    const ownerPrevisto = SystemProgram.programId.toBase58();
    checagens.push({
      ok: destinoPos?.owner === ownerPrevisto,
      texto: `owner do destino no pos-estado = ${ownerPrevisto} (previsto: System Program)`,
    });
    const destinoLamports = destinoPos === null ? null : paraBigint(destinoPos.lamports);
    checagens.push({
      ok: destinoLamports === lamports,
      texto: `lamports do destino no pos-estado = quantidade transferida (${lamports})`,
    });
    const origemLamports = origemPos === null ? null : paraBigint(origemPos.lamports);
    const esperado = saldoAntes - lamports - taxaBig;
    let textoOrigem = `lamports da origem no pos-estado = antes - quantidade - taxa estimada (${esperado})`;
    if (origemLamports !== null && origemLamports !== esperado) {
      textoOrigem +=
        origemLamports === saldoAntes - lamports
          ? "  -> obtido reflete so a quantidade, sem a taxa"
          : `  -> obtido ${origemLamports}; possivel atividade concorrente entre os slots`;
    }
    checagens.push({ ok: origemLamports === esperado, texto: textoOrigem });
  }

  // --- leitura DEPOIS: confirma que nada foi gravado on-chain
  console.log(`\n== DEPOIS (estado on-chain, minContextSlot ${sim.context.slot}) ==`);
  try {
    const depois = await conexao.getMultipleAccountsInfoAndContext(enderecos, {
      commitment,
      minContextSlot: sim.context.slot,
    });
    console.log(`slot da leitura:  ${depois.context.slot}`);
    const origemDepois = depois.value[0] ?? null;
    const destinoDepois = depois.value[1] ?? null;
    if (origemDepois === null) {
      console.log("  origem: nao encontrada na nova leitura");
    } else {
      console.log(`  origem:  saldo ${origemDepois.lamports}  diferenca vs antes ${diferenca(origemAntesInfo.lamports, origemDepois.lamports)}`);
    }
    console.log(`  destino: ${destinoDepois === null ? "continua INEXISTENTE on-chain" : `EXISTE on-chain com ${destinoDepois.lamports} lamports (inesperado)`}`);
    checagens.push({ ok: destinoDepois === null, texto: "destino continua inexistente on-chain depois da simulacao" });
  } catch (erro) {
    console.log(`  nova leitura falhou: ${redigir(mensagemDe(erro), rpcUrl)}`);
    checagens.push({ ok: false, texto: "leitura posterior on-chain realizada" });
  }
  console.log("obs: a origem e publica e controlada por terceiros. Uma diferenca entre as");
  console.log("     leituras pode vir de outra tx concorrente; a comparacao e verificacao");
  console.log("     pratica, nao prova isolada do efeito (ou nao) da simulacao na rede.");
  console.log("     minContextSlot so impede estado ANTERIOR ao minimo; nao congela a rede.");

  if (checagens.length > 0) {
    console.log("\n== VERIFICACOES DO EXPERIMENTO ==");
    for (const c of checagens) console.log(`  [${c.ok ? "ok" : "FALHOU"}] ${c.texto}`);
  }

  if (falhou) return EXIT_SIMULACAO_FALHOU;
  return checagens.every((c) => c.ok) ? EXIT_OK : EXIT_SANIDADE;
}

process.exitCode = await main();
