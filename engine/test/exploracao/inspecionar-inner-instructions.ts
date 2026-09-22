/**
 * Script de exploracao: SIMULA a criacao de uma Associated Token Account em
 * devnet e inspeciona as innerInstructions (CPIs) devolvidas pelo RPC.
 *
 *   pnpm exec tsx --env-file=.env test/exploracao/inspecionar-inner-instructions.ts [fee-payer]
 *
 * Por que ATA: uma transferencia do System Program nao chama ninguem. O
 * Associated Token Program, ao criar a conta, chama System Program e Token
 * Program por CPI -- e e isso que queremos observar.
 *
 * Nao assina validamente, nao envia, nao confirma, nao persiste chave.
 * A transacao e simulada com sigVerify: false e NAO poderia ser enviada.
 *
 * Codigos de saida:
 *   0  simulacao executada, err = null, CPIs observadas
 *   1  entrada ou configuracao invalida (inclui RPC que nao e devnet)
 *   2  conta necessaria inexistente (fee payer ou mint)
 *   3  conta inadequada (fee payer executavel / nao-System, mint fora do Token Program)
 *   4  saldo do fee payer insuficiente para taxa + rent da ATA
 *   5  falha de transporte ou RPC
 *   6  simulacao executada, err preenchido (a tx FALHARIA)
 *   7  resposta inconsistente ou em formato que o SDK instalado nao aceita
 *   8  estrutura ok, mas uma verificacao do experimento falhou
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import { z } from "zod";

const GENESIS_DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
// Conta publica de devnet ja usada nos experimentos anteriores.
const FEE_PAYER_PADRAO = "11111111111111111111111111111112";
const MAX_TENTATIVAS_OWNER = 3;
const MAX_LOGS = 40;
const MAX_DADOS_CHARS = 48;

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

function lerFeePayer(argv: readonly string[]): Resultado<PublicKey> {
  const entrada = argv[2] ?? FEE_PAYER_PADRAO;
  if (argv.length > 3) return { ok: false, erro: "Uso: inspecionar-inner-instructions.ts [fee-payer-base58]" };
  try {
    return { ok: true, valor: new PublicKey(entrada) };
  } catch {
    return { ok: false, erro: `Endereco invalido: "${entrada}" nao e uma chave publica base58 de 32 bytes.` };
  }
}

function redigir(texto: string, rpcUrl: string): string {
  return texto
    .split(rpcUrl)
    .join("<rpc-devnet>")
    .replace(/api-key=[^&\s"']+/gi, "api-key=***");
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

// ---------------------------------------------------------------- narrowing

function ehRegistro(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ehEnderecoBase58(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    return bs58.decode(v).length === 32;
  } catch {
    return false;
  }
}

/** stackHeight nao e tipado pelo SDK; o type() do superstruct deixa passar. */
function lerStackHeight(ix: object): number | null {
  if (!("stackHeight" in ix)) return null;
  const v: unknown = ix.stackHeight;
  return typeof v === "number" ? v : null;
}

/** Visao normalizada de uma instrucao interna, sem decodificar protocolo. */
type InternaVista =
  | { forma: "parsed"; programa: string; programId: string; tipo: string | null; campos: { campo: string; valor: string }[] }
  | { forma: "parcialmente-decodificada"; programId: string; contas: string[]; dados: string }
  | { forma: "compilada"; programId: string; contas: string[]; dados: string }
  | { forma: "desconhecida"; detalhe: string };

/**
 * O RPC devolve jsonParsed quando consegue e json compilado quando nao consegue.
 * O tipo do SDK so prev as duas primeiras formas; a terceira e tratada
 * defensivamente (e, na pratica, o superstruct do SDK a rejeitaria antes).
 */
function verInterna(ix: object, contasDaMensagem: readonly string[]): InternaVista {
  // forma jsonParsed: { program, programId, parsed }
  if ("parsed" in ix && "program" in ix && "programId" in ix) {
    const programa = typeof ix.program === "string" ? ix.program : "?";
    const programId = String(ix.programId);
    const parsed: unknown = ix.parsed;
    let tipo: string | null = null;
    const campos: { campo: string; valor: string }[] = [];
    if (ehRegistro(parsed)) {
      if (typeof parsed["type"] === "string") tipo = parsed["type"];
      const info: unknown = parsed["info"];
      if (ehRegistro(info)) {
        // Sem decodificar protocolo: so mostramos os campos que SAO enderecos.
        for (const [campo, valor] of Object.entries(info)) {
          if (ehEnderecoBase58(valor)) campos.push({ campo, valor });
        }
      }
    }
    return { forma: "parsed", programa, programId, tipo, campos };
  }
  // forma parcialmente decodificada: { programId, accounts: PublicKey[], data }
  if ("programId" in ix && "accounts" in ix && "data" in ix) {
    const contas = Array.isArray(ix.accounts) ? ix.accounts.map((c) => String(c)) : [];
    return {
      forma: "parcialmente-decodificada",
      programId: String(ix.programId),
      contas,
      dados: typeof ix.data === "string" ? ix.data : "?",
    };
  }
  // forma compilada: indices, nao enderecos -- precisa resolver contra a mensagem.
  if ("programIdIndex" in ix && "accounts" in ix) {
    const idxPrograma: unknown = ix.programIdIndex;
    const programId =
      typeof idxPrograma === "number" ? (contasDaMensagem[idxPrograma] ?? `#${idxPrograma} <nao resolvido>`) : "?";
    const brutas: unknown = ix.accounts;
    const contas = Array.isArray(brutas)
      ? brutas.map((i) => (typeof i === "number" ? (contasDaMensagem[i] ?? `#${i} <nao resolvido>`) : "?"))
      : [];
    return {
      forma: "compilada",
      programId,
      contas,
      dados: "data" in ix && typeof ix.data === "string" ? ix.data : "?",
    };
  }
  return { forma: "desconhecida", detalhe: JSON.stringify(ix).slice(0, 120) };
}

function truncar(s: string): string {
  return s.length > MAX_DADOS_CHARS ? `${s.slice(0, MAX_DADOS_CHARS)}... (+${s.length - MAX_DADOS_CHARS} chars)` : s;
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const config = lerConfig(process.env);
  if (!config.ok) {
    console.error(config.erro);
    return EXIT_ENTRADA;
  }
  const feePayer = lerFeePayer(process.argv);
  if (!feePayer.ok) {
    console.error(feePayer.erro);
    return EXIT_ENTRADA;
  }
  const pagador = feePayer.valor;
  const { rpcUrl, commitment } = config.valor;
  const conexao = new Connection(rpcUrl, { commitment, disableRetryOnRateLimit: true });
  const falhaRpc = (etapa: string, erro: unknown): number => {
    console.error(`Falha de RPC (${etapa}): ${redigir(mensagemDe(erro), rpcUrl)}`);
    return EXIT_RPC;
  };

  try {
    if ((await conexao.getGenesisHash()) !== GENESIS_DEVNET) {
      console.error("VETO_RPC_URL_DEVNET respondeu, mas nao e devnet (genesis hash diferente). Recusado.");
      return EXIT_ENTRADA;
    }
  } catch (erro) {
    return falhaRpc("getGenesisHash", erro);
  }

  // --- owner descartavel + derivacao da ATA
  // Keypair.generate() so para obter uma chave publica NA CURVA (exigencia da
  // derivacao de ATA). secretKey nunca e lida, impressa nem guardada.
  let owner = Keypair.generate().publicKey;
  let ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  let leitura: Awaited<ReturnType<Connection["getMultipleAccountsInfoAndContext"]>> | null = null;
  let tentativas = 0;

  while (tentativas < MAX_TENTATIVAS_OWNER) {
    tentativas++;
    try {
      leitura = await conexao.getMultipleAccountsInfoAndContext([pagador, NATIVE_MINT, ata], { commitment });
    } catch (erro) {
      return falhaRpc("leitura anterior (pagador, mint, ata)", erro);
    }
    if (leitura.value.length !== 3) {
      console.error(`Leitura anterior devolveu ${leitura.value.length} contas para 3 pedidas.`);
      return EXIT_RESPOSTA_INCONSISTENTE;
    }
    if ((leitura.value[2] ?? null) === null) break;
    console.error(`ATA ${ata.toBase58()} ja existe (colisao improvavel); gerando outro owner.`);
    owner = Keypair.generate().publicKey;
    ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    leitura = null;
  }
  if (leitura === null) {
    console.error(`ATA ainda existente apos ${MAX_TENTATIVAS_OWNER} tentativas; experimento abortado.`);
    return EXIT_SANIDADE;
  }

  const pagadorInfo = leitura.value[0] ?? null;
  const mintInfo = leitura.value[1] ?? null;
  if (pagadorInfo === null) {
    console.error(`Fee payer nao existe em devnet: ${pagador.toBase58()}`);
    return EXIT_INEXISTENTE;
  }
  if (pagadorInfo.executable || !pagadorInfo.owner.equals(SystemProgram.programId)) {
    console.error("Fee payer inadequado: precisa ser conta nao-executavel do System Program.");
    return EXIT_INADEQUADA;
  }
  if (mintInfo === null) {
    console.error(`Mint ${NATIVE_MINT.toBase58()} nao existe em devnet.`);
    return EXIT_INEXISTENTE;
  }
  if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    console.error(`Mint inadequado: owner ${mintInfo.owner.toBase58()} nao e o Token Program.`);
    return EXIT_INADEQUADA;
  }

  // --- montagem: uma unica instrucao, a criacao da ATA
  // Escolha consciente pela versao NAO idempotente: se a ATA existisse, a
  // idempotente nao faria nada e devolveria zero CPIs -- que eu leria como
  // "sem CPI" em vez de "premissa quebrada". A normal falha alto.
  const instrucao = createAssociatedTokenAccountInstruction(
    pagador,
    ata,
    owner,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  let blockhash: string;
  try {
    blockhash = (await conexao.getLatestBlockhash(commitment)).blockhash;
  } catch (erro) {
    return falhaRpc("getLatestBlockhash", erro);
  }
  const mensagem = new TransactionMessage({
    payerKey: pagador,
    recentBlockhash: blockhash,
    instructions: [instrucao],
  }).compileToV0Message();
  const tx = new VersionedTransaction(mensagem);
  const placeholderZerado = tx.signatures.every((s) => s.every((b) => b === 0));

  let taxa: number | null;
  let rentAta: number;
  try {
    taxa = (await conexao.getFeeForMessage(mensagem, commitment)).value;
    rentAta = await conexao.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, commitment);
  } catch (erro) {
    return falhaRpc("getFeeForMessage / getMinimumBalanceForRentExemption", erro);
  }
  if (taxa === null) {
    console.error("RPC nao estimou a taxa (blockhash expirado?). Experimento recusado.");
    return EXIT_RPC;
  }
  if (!Number.isSafeInteger(pagadorInfo.lamports) || pagadorInfo.lamports < taxa + rentAta) {
    console.error(`Saldo do fee payer insuficiente: ${pagadorInfo.lamports} < taxa ${taxa} + rent ${rentAta}.`);
    return EXIT_SALDO;
  }

  console.log("== ANTES ==");
  console.log(`rede:             devnet (genesis conferido)`);
  console.log(`slot da leitura:  ${leitura.context.slot}`);
  console.log(`fee payer:        ${pagador.toBase58()}  (${pagadorInfo.lamports} lamports)`);
  console.log(`mint (wSOL):      ${NATIVE_MINT.toBase58()}  owner ${mintInfo.owner.toBase58()}`);
  console.log(`owner da ATA:     ${owner.toBase58()}  (Keypair descartavel; secretKey nunca lida)`);
  console.log(`ATA derivada:     ${ata.toBase58()}`);
  console.log(`ATA antes:        INEXISTENTE on-chain`);
  console.log(`rent da ATA:      ${rentAta} lamports (${ACCOUNT_SIZE} bytes)`);
  console.log(`taxa estimada:    ${taxa} lamports`);
  console.log(`versao mensagem:  ${mensagem.version}`);
  console.log(`assinatura:       ${placeholderZerado ? "placeholder de 64 bytes zerados" : "NAO ZERADA -- inesperado"}`);

  // --- instrucoes externas da mensagem
  const contasDaMensagem = mensagem.staticAccountKeys.map((k) => k.toBase58());
  console.log(`\n== INSTRUCOES EXTERNAS (${mensagem.compiledInstructions.length}) ==`);
  mensagem.compiledInstructions.forEach((ix, i) => {
    console.log(`  [${i}] programa #${ix.programIdIndex} ${contasDaMensagem[ix.programIdIndex] ?? "<nao resolvido>"}`);
    for (const idx of ix.accountKeyIndexes) {
      console.log(`        conta #${idx} ${contasDaMensagem[idx] ?? "<nao resolvido>"}`);
    }
    console.log(`        data  ${ix.data.length} bytes, base58 ${truncar(bs58.encode(ix.data))}`);
  });

  // --- simulacao com innerInstructions
  const minContextSlot = leitura.context.slot;
  let sim: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    sim = await conexao.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      innerInstructions: true,
      commitment,
      minContextSlot,
    });
  } catch (erro) {
    const texto = redigir(mensagemDe(erro), rpcUrl);
    // O superstruct do SDK so aceita innerInstructions jsonParsed ou
    // parcialmente decodificadas; a forma compilada e rejeitada aqui.
    if (/struct|Expected|At path/i.test(texto)) {
      console.error(`Resposta em formato que o SDK instalado nao aceita: ${texto}`);
      return EXIT_RESPOSTA_INCONSISTENTE;
    }
    return falhaRpc("simulateTransaction", erro);
  }
  const r = sim.value;
  const logs = r.logs;

  console.log("\n== SIMULACAO (nada foi transmitido) ==");
  console.log(`minContextSlot:   ${minContextSlot}`);
  console.log(`context.slot:     ${sim.context.slot}`);
  console.log("sigVerify: false | replaceRecentBlockhash: true | innerInstructions: true");
  console.log(`err:              ${r.err === null ? "null" : JSON.stringify(r.err)}`);
  console.log(`unitsConsumed:    ${r.unitsConsumed ?? "nao retornado"}`);
  if (logs === null) {
    console.log("logs:             indisponiveis (RPC devolveu null)");
  } else {
    console.log(`logs (${logs.length}):`);
    for (const l of logs.slice(0, MAX_LOGS)) console.log(`  ${l}`);
    if (logs.length > MAX_LOGS) console.log(`  ... ${logs.length - MAX_LOGS} linha(s) omitida(s) pelo limite`);
  }

  // Distingue falha antes de executar de falha durante a execucao.
  if (r.err !== null) {
    const executou = logs !== null && logs.length > 0;
    console.log(
      executou
        ? "diagnostico:      executou parcialmente e terminou com erro (ha logs de programa)"
        : "diagnostico:      falhou ANTES de executar (sem logs de programa)",
    );
  }

  // --- innerInstructions
  console.log("\n== INSTRUCOES INTERNAS (CPI) ==");
  const inner = r.innerInstructions;
  const checagens: { ok: boolean; texto: string }[] = [];
  if (inner === undefined) {
    console.log("  campo AUSENTE na resposta: pedimos innerInstructions: true, entao o RPC");
    console.log("  ignorou a opcao ou nao a suporta nesta versao.");
    checagens.push({ ok: false, texto: "campo innerInstructions presente na resposta" });
  } else if (inner === null) {
    console.log("  campo presente e igual a null: o RPC nao forneceu as CPIs desta simulacao.");
    checagens.push({ ok: false, texto: "innerInstructions nao e null" });
  } else if (inner.length === 0) {
    console.log("  lista VAZIA: a execucao ocorreu e nenhuma CPI aconteceu.");
    checagens.push({ ok: false, texto: "pelo menos um grupo de CPI observado" });
  } else {
    console.log(`  ${inner.length} grupo(s). Cada grupo pertence a UMA instrucao externa (campo index).`);
    let totalInternas = 0;
    for (const grupo of inner) {
      const externa = mensagem.compiledInstructions[grupo.index];
      const programaExterno =
        externa === undefined ? "<indice fora da mensagem>" : (contasDaMensagem[externa.programIdIndex] ?? "<nao resolvido>");
      console.log(`  grupo index=${grupo.index} -> instrucao externa [${grupo.index}], programa ${programaExterno}`);
      console.log(`    ${grupo.instructions.length} instrucao(oes) interna(s):`);
      grupo.instructions.forEach((ix, pos) => {
        totalInternas++;
        const vista = verInterna(ix, contasDaMensagem);
        const stack = lerStackHeight(ix);
        const sufixoStack = stack === null ? "  stackHeight: nao retornado" : `  stackHeight: ${stack}`;
        switch (vista.forma) {
          case "parsed":
            console.log(`    (${pos}) [jsonParsed] programa ${vista.programa} ${vista.programId}${sufixoStack}`);
            console.log(`          tipo: ${vista.tipo ?? "nao informado"}`);
            if (vista.campos.length === 0) {
              console.log("          contas: nenhum campo do parsed e endereco");
            } else {
              for (const c of vista.campos) console.log(`          conta (${c.campo}): ${c.valor}`);
            }
            console.log("          dados brutos: nao vieram (forma jsonParsed substitui data por parsed)");
            break;
          case "parcialmente-decodificada":
            console.log(`    (${pos}) [parcial] programa ${vista.programId}${sufixoStack}`);
            for (const c of vista.contas) console.log(`          conta: ${c}`);
            console.log(`          data (base58): ${truncar(vista.dados)}`);
            break;
          case "compilada":
            console.log(`    (${pos}) [compilada, indices resolvidos] programa ${vista.programId}${sufixoStack}`);
            for (const c of vista.contas) console.log(`          conta: ${c}`);
            console.log(`          data (base58): ${truncar(vista.dados)}`);
            break;
          case "desconhecida":
            console.log(`    (${pos}) [FORMATO DESCONHECIDO]${sufixoStack} ${vista.detalhe}`);
            break;
        }
      });
    }
    console.log(`  total de instrucoes internas: ${totalInternas}`);
    checagens.push({ ok: true, texto: `pelo menos um grupo de CPI observado (${inner.length})` });
  }

  // --- leitura posterior
  console.log(`\n== DEPOIS (on-chain, minContextSlot ${sim.context.slot}) ==`);
  try {
    const depois = await conexao.getMultipleAccountsInfoAndContext([pagador, ata], {
      commitment,
      minContextSlot: sim.context.slot,
    });
    const ataDepois = depois.value[1] ?? null;
    const pagadorDepois = depois.value[0] ?? null;
    console.log(`slot da leitura:  ${depois.context.slot}`);
    console.log(`fee payer:        ${pagadorDepois === null ? "nao encontrado" : `${pagadorDepois.lamports} lamports`}`);
    console.log(`ATA:              ${ataDepois === null ? "continua INEXISTENTE on-chain" : "EXISTE on-chain (inesperado)"}`);
    checagens.push({ ok: ataDepois === null, texto: "ATA continua inexistente on-chain apos a simulacao" });
  } catch (erro) {
    console.log(`  nova leitura falhou: ${redigir(mensagemDe(erro), rpcUrl)}`);
    checagens.push({ ok: false, texto: "leitura posterior on-chain realizada" });
  }

  console.log("\n== VERIFICACOES DO EXPERIMENTO ==");
  for (const c of checagens) console.log(`  [${c.ok ? "ok" : "FALHOU"}] ${c.texto}`);

  if (r.err !== null) return EXIT_SIMULACAO_FALHOU;
  return checagens.every((c) => c.ok) ? EXIT_OK : EXIT_SANIDADE;
}

process.exitCode = await main();
