/**
 * Script de exploracao: SIMULA uma transferencia de lamports em devnet.
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
 *   0  simulacao executada, err = null (a tx passaria)
 *   1  entrada ou configuracao invalida (inclui RPC que nao e devnet e lamports invalido)
 *   2  conta de origem nao existe
 *   3  conta de origem inadequada (executavel ou owner != System Program)
 *   4  saldo insuficiente para 1 lamport + taxa
 *   5  falha de transporte ou RPC
 *   6  simulacao executada, err preenchido (a tx FALHARIA)
 */
import { randomBytes } from "node:crypto";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import { z } from "zod";

const GENESIS_DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const QUANTIDADE_PADRAO = 1n;
// SystemProgram.transfer codifica lamports como u64 (getU64Codec no SDK instalado).
const U64_MAX = 2n ** 64n - 1n;
const MAX_LOGS = 30;

const EXIT_OK = 0;
const EXIT_ENTRADA = 1;
const EXIT_INEXISTENTE = 2;
const EXIT_INADEQUADA = 3;
const EXIT_SALDO = 4;
const EXIT_RPC = 5;
const EXIT_SIMULACAO_FALHOU = 6;

const esquemaUrl = z.url({ protocol: /^https?$/ });
const esquemaCommitment = z.enum(["processed", "confirmed", "finalized"]);

type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };
type Config = { rpcUrl: string; commitment: Commitment };
type Entrada = { origem: PublicKey; lamports: bigint };

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

// lamports chega como number. Diferenca so e exata se os dois forem inteiros seguros.
function diferenca(antes: number, depois: number): string {
  if (!Number.isSafeInteger(antes) || !Number.isSafeInteger(depois)) {
    return "imprecisa (valor acima de 2^53-1)";
  }
  const d = BigInt(depois) - BigInt(antes);
  return d > 0n ? `+${d}` : `${d}`;
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

  // --- leitura ANTES
  let antes: Awaited<ReturnType<Connection["getAccountInfoAndContext"]>>;
  try {
    antes = await conexao.getAccountInfoAndContext(origem, { commitment });
  } catch (erro) {
    return falhaRpc("leitura anterior da origem", erro);
  }
  const contaAntes = antes.value;
  if (contaAntes === null) {
    console.error(`Conta de origem nao existe em devnet (commitment ${commitment}): ${origem.toBase58()}`);
    return EXIT_INEXISTENTE;
  }
  if (contaAntes.executable) {
    console.error("Conta de origem inadequada: e executavel (programa), nao carteira.");
    return EXIT_INADEQUADA;
  }
  if (!contaAntes.owner.equals(SystemProgram.programId)) {
    console.error(
      `Conta de origem inadequada: owner ${contaAntes.owner.toBase58()} nao e o System Program; ` +
        "SystemProgram.transfer so debita contas do System Program.",
    );
    return EXIT_INADEQUADA;
  }

  // --- montagem
  // Destino: 32 bytes aleatorios. Nao existe chave privada correspondente conhecida.
  const destino = new PublicKey(randomBytes(32));
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

  // Comparacao em bigint. number -> bigint so e exato se for inteiro seguro;
  // se nao for, o saldo nao e verificavel e o experimento e recusado.
  if (!Number.isSafeInteger(contaAntes.lamports) || !Number.isSafeInteger(taxa) || !Number.isSafeInteger(minimoRent)) {
    console.error("Saldo, taxa ou minimo de rent acima de 2^53-1: comparacao nao e confiavel; experimento recusado.");
    return EXIT_SALDO;
  }
  if (BigInt(contaAntes.lamports) < lamports + BigInt(taxa)) {
    console.error(`Saldo insuficiente: ${contaAntes.lamports} lamports < ${lamports} + taxa ${taxa}.`);
    return EXIT_SALDO;
  }
  const abaixoDoMinimo = lamports < BigInt(minimoRent);

  console.log("== ANTES ==");
  console.log(`rede:             devnet (genesis conferido)`);
  console.log(`origem:           ${origem.toBase58()}`);
  console.log(`owner da origem:  ${contaAntes.owner.toBase58()}`);
  console.log(`saldo antes:      ${contaAntes.lamports} lamports`);
  console.log(`slot da leitura:  ${antes.context.slot}`);

  console.log("\n== TRANSACAO MONTADA (nao assinada validamente) ==");
  console.log(`destino temp.:    ${destino.toBase58()}  (32 bytes aleatorios, sem chave privada)`);
  console.log(`quantidade:       ${lamports} lamports`);
  console.log(`minimo rent-exempt (0 bytes, via RPC): ${minimoRent} lamports`);
  console.log(
    `abaixo do minimo: ${abaixoDoMinimo ? "SIM" : "nao"}` +
      "  (so importa porque o destino e conta NOVA; para conta existente nao se aplica assim)",
  );
  console.log(`taxa estimada:    ${taxa} lamports`);
  console.log(`versao mensagem:  ${mensagem.version}`);
  console.log(`signers exigidos: ${mensagem.header.numRequiredSignatures} (indice 0 = ${mensagem.staticAccountKeys[0]?.toBase58() ?? "?"})`);
  console.log(`assinatura:       ${placeholderZerado ? "placeholder de 64 bytes zerados" : "NAO ZERADA -- inesperado"}`);

  // --- simulacao
  const opcoes = { sigVerify: false, replaceRecentBlockhash: true, commitment };
  let sim: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    sim = await conexao.simulateTransaction(tx, opcoes);
  } catch (erro) {
    return falhaRpc("simulateTransaction", erro);
  }
  const r = sim.value;

  console.log("\n== SIMULACAO (simulateTransaction -- nada foi transmitido) ==");
  console.log(`slot do contexto: ${sim.context.slot}`);
  console.log(`sigVerify:        ${opcoes.sigVerify}`);
  console.log(`replaceRecentBlockhash: ${opcoes.replaceRecentBlockhash}`);
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

  // --- leitura DEPOIS
  console.log("\n== DEPOIS ==");
  try {
    const depois = await conexao.getAccountInfoAndContext(origem, { commitment });
    if (depois.value === null) {
      console.log(`origem nao encontrada na nova leitura (slot ${depois.context.slot})`);
    } else {
      console.log(`saldo depois:     ${depois.value.lamports} lamports`);
      console.log(`slot da leitura:  ${depois.context.slot}`);
      console.log(`diferenca:        ${diferenca(contaAntes.lamports, depois.value.lamports)} lamports`);
    }
  } catch (erro) {
    console.log(`nova leitura falhou: ${redigir(mensagemDe(erro), rpcUrl)}`);
  }
  console.log("obs: a origem e publica e controlada por terceiros. Uma diferenca entre as");
  console.log("     leituras pode vir de outra tx concorrente; a comparacao e verificacao");
  console.log("     pratica, nao prova isolada do efeito (ou nao) da simulacao na rede.");

  return r.err === null ? EXIT_OK : EXIT_SIMULACAO_FALHOU;
}

process.exitCode = await main();
