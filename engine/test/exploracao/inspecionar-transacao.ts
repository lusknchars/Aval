/**
 * Script de exploracao: inspeciona uma transacao JA CONFIRMADA na mainnet.
 *
 *   pnpm exec tsx --env-file=.env test/exploracao/inspecionar-transacao.ts <assinatura>
 *
 * Leitura historica via getTransaction -- nao e simulacao. Nao assina, nao
 * envia, nao decodifica instrucao de protocolo, nao produz EffectSet.
 *
 * Codigos de saida:
 *   0  transacao encontrada e executada com sucesso
 *   1  entrada ou configuracao invalida (inclui RPC que nao e mainnet)
 *   2  RPC respondeu, mas a transacao nao foi encontrada
 *   3  falha de RPC (rede, autenticacao, rate limit...)
 *   4  transacao encontrada, mas a execucao FALHOU on-chain (meta.err)
 *   5  transacao encontrada, mas sem meta: status desconhecido
 */
import {
  Connection,
  type Finality,
  type TokenBalance,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

const GENESIS_MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// Maior versao que o @solana/web3.js instalado sabe desserializar (legacy, 0, 1).
// Pedir mais que isso faria o RPC devolver uma tx que o SDK nao consegue ler.
const MAX_VERSAO_SUPORTADA = 1;

const EXIT_OK = 0;
const EXIT_ENTRADA = 1;
const EXIT_NAO_ENCONTRADA = 2;
const EXIT_RPC = 3;
const EXIT_TX_FALHOU = 4;
const EXIT_SEM_META = 5;

// Limites de impressao. O que passar disso e contado e avisado, nunca some calado.
const MAX_CONTAS = 64;
const MAX_INSTRUCOES = 20;
const MAX_INTERNAS_POR_EXTERNA = 12;
const MAX_CONTAS_POR_INSTRUCAO = 12;
const MAX_DATA_CHARS = 48;

const esquemaUrl = z.url({ protocol: /^https?$/ });
const esquemaCommitment = z.enum(["processed", "confirmed", "finalized"]);

type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };
type Config = { rpcUrl: string; commitment: Finality };

// ---------------------------------------------------------------- entrada

function lerConfig(env: NodeJS.ProcessEnv): Resultado<Config> {
  const url = env["VETO_RPC_URL"];
  if (url === undefined || url === "") {
    return { ok: false, erro: "VETO_RPC_URL nao definida. Preencha no .env." };
  }
  if (!esquemaUrl.safeParse(url).success) {
    return { ok: false, erro: "VETO_RPC_URL nao e uma URL http(s) valida." };
  }
  const parse = esquemaCommitment.safeParse(env["VETO_RPC_COMMITMENT"]);
  if (!parse.success) {
    return {
      ok: false,
      erro: "VETO_RPC_COMMITMENT ausente ou invalido. Use processed, confirmed ou finalized.",
    };
  }
  const commitment = parse.data;
  if (commitment === "processed") {
    // getTransaction so aceita Finality: o RPC rejeita "processed" para historico.
    return {
      ok: false,
      erro: "VETO_RPC_COMMITMENT=processed nao vale para getTransaction (so confirmed ou finalized).",
    };
  }
  return { ok: true, valor: { rpcUrl: url, commitment } };
}

function lerAssinatura(argv: readonly string[]): Resultado<string> {
  const entrada = argv[2];
  if (entrada === undefined || argv.length > 3) {
    return { ok: false, erro: "Uso: inspecionar-transacao.ts <assinatura-base58>" };
  }
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(entrada);
  } catch {
    return { ok: false, erro: `Assinatura invalida: "${entrada}" nao e base58.` };
  }
  if (bytes.length !== 64) {
    return {
      ok: false,
      erro: `Assinatura invalida: decodifica para ${bytes.length} bytes; assinatura Ed25519 tem 64.`,
    };
  }
  return { ok: true, valor: entrada };
}

// Erro do SDK pode citar a URL. Apaga a URL inteira e qualquer api-key.
function redigir(texto: string, rpcUrl: string): string {
  return texto
    .split(rpcUrl)
    .join("<rpc-mainnet>")
    .replace(/api-key=[^&\s"']+/gi, "api-key=***");
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

// ---------------------------------------------------------------- contas

type Conta = {
  indice: number;
  endereco: string;
  origem: "estatica" | "ALT writable" | "ALT readonly";
  signer: boolean;
  writable: boolean;
  alt: { tabela: string; indice: number } | null;
};

/**
 * Monta a lista de contas na ordem que os indices das instrucoes usam:
 * estaticas, depois writable de todas as ALTs, depois readonly de todas.
 */
function resolverContas(tx: VersionedTransactionResponse): { contas: Conta[]; avisos: string[] } {
  const msg = tx.transaction.message;
  const h = msg.header;
  const estaticas = msg.staticAccountKeys;
  const avisos: string[] = [];

  // signer/writable das estaticas saem da posicao + header:
  // [signers writable][signers readonly][nao-signers writable][nao-signers readonly]
  const contas: Conta[] = estaticas.map((pk, i) => {
    const signer = i < h.numRequiredSignatures;
    const writable = signer
      ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts
      : i < estaticas.length - h.numReadonlyUnsignedAccounts;
    return { indice: i, endereco: pk.toBase58(), origem: "estatica", signer, writable, alt: null };
  });

  const lookups = msg.addressTableLookups;
  if (lookups.length === 0) return { contas, avisos };

  const carregados = tx.meta?.loadedAddresses;
  if (carregados === undefined) {
    avisos.push(
      `a tx usa ${lookups.length} ALT(s), mas o RPC nao devolveu meta.loadedAddresses: ` +
        "indices acima de " + (estaticas.length - 1) + " ficam sem endereco.",
    );
    return { contas, avisos };
  }

  const origemW = lookups.flatMap((l) =>
    l.writableIndexes.map((i) => ({ tabela: l.accountKey.toBase58(), indice: i })),
  );
  const origemR = lookups.flatMap((l) =>
    l.readonlyIndexes.map((i) => ({ tabela: l.accountKey.toBase58(), indice: i })),
  );
  if (origemW.length !== carregados.writable.length || origemR.length !== carregados.readonly.length) {
    avisos.push("contagem de loadedAddresses nao bate com os indices das ALTs; origem por tabela pode estar errada.");
  }

  carregados.writable.forEach((pk, k) => {
    contas.push({
      indice: contas.length, endereco: pk.toBase58(), origem: "ALT writable",
      signer: false, writable: true, alt: origemW[k] ?? null,
    });
  });
  carregados.readonly.forEach((pk, k) => {
    contas.push({
      indice: contas.length, endereco: pk.toBase58(), origem: "ALT readonly",
      signer: false, writable: false, alt: origemR[k] ?? null,
    });
  });
  return { contas, avisos };
}

// ---------------------------------------------------------------- formatacao

function limitar<T>(itens: readonly T[], max: number): { visiveis: readonly T[]; omitidos: number } {
  return { visiveis: itens.slice(0, max), omitidos: Math.max(0, itens.length - max) };
}

function avisoTruncado(omitidos: number, oque: string, recuo = "  "): void {
  if (omitidos > 0) console.log(`${recuo}... ${omitidos} ${oque} omitido(s) pelo limite de impressao`);
}

function nomeConta(contas: readonly Conta[], i: number): string {
  const c = contas[i];
  return c === undefined ? `#${i} <nao resolvida>` : `#${i} ${c.endereco}`;
}

function resumirData(bytes: Uint8Array): string {
  if (bytes.length === 0) return "0 bytes";
  const b58 = bs58.encode(bytes);
  const corpo = b58.length > MAX_DATA_CHARS ? `${b58.slice(0, MAX_DATA_CHARS)}...` : b58;
  return `${bytes.length} bytes, base58 ${corpo}`;
}

function comSinal(n: bigint): string {
  return n > 0n ? `+${n}` : `${n}`;
}

/** Quantidade bruta (string de inteiro) -> decimal exato, sem passar por number. */
function formatarBruto(bruto: bigint, decimals: number): string {
  const negativo = bruto < 0n;
  const s = (negativo ? -bruto : bruto).toString().padStart(decimals + 1, "0");
  const inteiro = s.slice(0, s.length - decimals);
  const fracao = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${negativo ? "-" : ""}${inteiro}${fracao === "" ? "" : `.${fracao}`}`;
}

function brutoParaBigint(amount: string): bigint | null {
  return /^\d+$/.test(amount) ? BigInt(amount) : null;
}

// ---------------------------------------------------------------- secoes

function imprimirResumo(tx: VersionedTransactionResponse, commitment: Finality): void {
  const bt = tx.blockTime;
  console.log("== RESUMO  (historico via getTransaction, NAO e simulacao) ==");
  console.log(`assinatura: ${tx.transaction.signatures[0] ?? "<ausente>"}`);
  console.log(`slot:       ${tx.slot}`);
  console.log(`blockTime:  ${bt === null || bt === undefined ? "indisponivel" : `${new Date(bt * 1000).toISOString()} (UTC)`}`);
  console.log(`versao:     ${tx.version === undefined ? "nao informada" : String(tx.version)}`);
  const msg = tx.transaction.message;
  if ("transactionConfig" in msg) {
    // Em v1 o compute budget e campo da mensagem, nao instrucao ComputeBudget.
    const c = msg.transactionConfig;
    console.log(
      `config v1:  computeUnitLimit=${c.computeUnitLimit ?? "-"} priorityFee=${c.priorityFee ?? "-"} ` +
        `heapSize=${c.heapSize ?? "-"} loadedAccountsDataSizeLimit=${c.loadedAccountsDataSizeLimit ?? "-"}`,
    );
  }
  console.log(`commitment: ${commitment}`);
  if (tx.meta === null) {
    console.log("status:     DESCONHECIDO (RPC nao devolveu meta)");
    console.log("fee:        indisponivel");
    return;
  }
  console.log(`status:     ${tx.meta.err === null ? "sucesso" : `FALHOU on-chain: ${JSON.stringify(tx.meta.err)}`}`);
  console.log(`fee:        ${tx.meta.fee} lamports`);
}

function imprimirContas(contas: readonly Conta[], avisos: readonly string[]): void {
  const nEst = contas.filter((c) => c.origem === "estatica").length;
  console.log(`\n== CONTAS  (${contas.length} total: ${nEst} estaticas, ${contas.length - nEst} via ALT) ==`);
  for (const a of avisos) console.log(`  aviso: ${a}`);
  const { visiveis, omitidos } = limitar(contas, MAX_CONTAS);
  for (const c of visiveis) {
    const flags = `${c.signer ? "S" : "-"}${c.writable ? "W" : "-"}`;
    const alt = c.alt === null ? "" : `  [tabela ${c.alt.tabela} idx ${c.alt.indice}]`;
    console.log(`  #${String(c.indice).padStart(2)} ${flags} ${c.endereco}  ${c.origem}${alt}`);
  }
  avisoTruncado(omitidos, "conta(s)");
  console.log("  legenda: S = signer, W = writable (como declarado na mensagem)");
}

function imprimirExternas(tx: VersionedTransactionResponse, contas: readonly Conta[]): void {
  const ixs = tx.transaction.message.compiledInstructions;
  console.log(`\n== INSTRUCOES EXTERNAS  (${ixs.length}) ==`);
  const { visiveis, omitidos } = limitar(ixs, MAX_INSTRUCOES);
  visiveis.forEach((ix, n) => {
    console.log(`  [${n}] programa ${nomeConta(contas, ix.programIdIndex)}`);
    const cs = limitar(ix.accountKeyIndexes, MAX_CONTAS_POR_INSTRUCAO);
    for (const i of cs.visiveis) console.log(`        conta ${nomeConta(contas, i)}`);
    avisoTruncado(cs.omitidos, "conta(s)", "        ");
    console.log(`        data  ${resumirData(ix.data)}`);
  });
  avisoTruncado(omitidos, "instrucao(oes)");
}

function imprimirInternas(tx: VersionedTransactionResponse, contas: readonly Conta[]): void {
  console.log("\n== INSTRUCOES INTERNAS (CPI) ==");
  const inner = tx.meta?.innerInstructions;
  if (tx.meta === null || inner === undefined || inner === null) {
    console.log("  indisponivel: o RPC nao devolveu innerInstructions para esta tx");
    return;
  }
  if (inner.length === 0) {
    console.log("  nenhuma: nenhum programa chamou outro programa (CPI)");
    return;
  }
  for (const grupo of inner) {
    console.log(`  da externa [${grupo.index}]: ${grupo.instructions.length} interna(s)`);
    const { visiveis, omitidos } = limitar(grupo.instructions, MAX_INTERNAS_POR_EXTERNA);
    visiveis.forEach((ix, n) => {
      let data: string;
      try {
        data = resumirData(bs58.decode(ix.data));
      } catch {
        data = "<data nao e base58 valido>";
      }
      const cs = limitar(ix.accounts, MAX_CONTAS_POR_INSTRUCAO);
      console.log(`    (${n}) programa ${nomeConta(contas, ix.programIdIndex)}`);
      console.log(`          contas ${cs.visiveis.map((i) => `#${i}`).join(" ")}${cs.omitidos > 0 ? ` (+${cs.omitidos})` : ""}`);
      console.log(`          data   ${data}`);
    });
    avisoTruncado(omitidos, "interna(s)", "    ");
  }
}

function imprimirSaldosSol(tx: VersionedTransactionResponse, contas: readonly Conta[]): void {
  console.log("\n== SALDOS SOL (lamports) ==");
  if (tx.meta === null) {
    console.log("  indisponivel: sem meta");
    return;
  }
  const { preBalances: pre, postBalances: post } = tx.meta;
  if (pre.length !== contas.length || post.length !== contas.length) {
    console.log(`  aviso: pre=${pre.length}, post=${post.length}, contas=${contas.length}; indices podem nao alinhar`);
  }
  let inalteradas = 0;
  const total = Math.max(pre.length, post.length);
  for (let i = 0; i < total; i++) {
    const p = pre[i];
    const q = post[i];
    if (p === undefined || q === undefined) {
      console.log(`  ${nomeConta(contas, i)}  pre=${p ?? "ausente"} post=${q ?? "ausente"}`);
      continue;
    }
    if (p === q) {
      inalteradas++;
      continue;
    }
    // BigInt so e exato aqui porque os dois ja sao inteiros seguros: nada se perdeu.
    const delta =
      Number.isSafeInteger(p) && Number.isSafeInteger(q)
        ? comSinal(BigInt(q) - BigInt(p))
        : "impreciso (valor acima de 2^53-1, ja chegou arredondado)";
    console.log(`  ${nomeConta(contas, i)}`);
    console.log(`        pre ${p}  post ${q}  delta ${delta}`);
  }
  console.log(`  ${inalteradas} conta(s) com saldo SOL inalterado (nao listadas)`);
}

function imprimirSaldosToken(tx: VersionedTransactionResponse, contas: readonly Conta[]): void {
  console.log("\n== SALDOS DE TOKEN (pareados por accountIndex + mint) ==");
  const meta = tx.meta;
  if (meta === null) {
    console.log("  indisponivel: sem meta");
    return;
  }
  const pre = meta.preTokenBalances;
  const post = meta.postTokenBalances;
  if (pre === null || pre === undefined || post === null || post === undefined) {
    console.log(`  indisponivel: preTokenBalances ${pre == null ? "ausente" : "ok"}, postTokenBalances ${post == null ? "ausente" : "ok"}`);
    return;
  }

  const pares = new Map<string, { indice: number; mint: string; pre: TokenBalance | null; post: TokenBalance | null }>();
  for (const b of pre) pares.set(`${b.accountIndex}:${b.mint}`, { indice: b.accountIndex, mint: b.mint, pre: b, post: null });
  for (const b of post) {
    const k = `${b.accountIndex}:${b.mint}`;
    const existente = pares.get(k);
    if (existente === undefined) pares.set(k, { indice: b.accountIndex, mint: b.mint, pre: null, post: b });
    else existente.post = b;
  }
  if (pares.size === 0) {
    console.log("  nenhum saldo de token reportado pelo RPC");
    return;
  }

  const ordenados = [...pares.values()].sort((a, b) => a.indice - b.indice);
  for (const par of ordenados) {
    const ref = par.post ?? par.pre;
    if (ref === null) continue;
    const dec = ref.uiTokenAmount.decimals;
    const donoPre = par.pre?.owner;
    const donoPost = par.post?.owner;
    const dono =
      donoPre !== undefined && donoPost !== undefined && donoPre !== donoPost
        ? `${donoPre} -> ${donoPost}  (MUDOU)`
        : (donoPost ?? donoPre ?? "nao fornecido pelo RPC");

    console.log(`  ${nomeConta(contas, par.indice)}`);
    console.log(`        mint     ${par.mint}`);
    console.log(`        owner    ${dono}`);
    console.log(`        decimals ${dec}`);

    const lado = (nome: string, b: TokenBalance | null, lamportsLado: number | undefined, pista: string): bigint | null => {
      if (b === null) {
        const dica = lamportsLado === 0 ? `  (conta com 0 lamports ${pista}: provavel ${nome === "pre" ? "criacao" : "fechamento"} nesta tx)` : "";
        console.log(`        ${nome.padEnd(4)}     ausente no RPC -- NAO e zero${dica}`);
        return null;
      }
      const bruto = brutoParaBigint(b.uiTokenAmount.amount);
      if (bruto === null) {
        console.log(`        ${nome.padEnd(4)}     bruto invalido: "${b.uiTokenAmount.amount}"`);
        return null;
      }
      // uiAmount e number (float): acima de ~15 digitos significativos ja e aproximado.
      const digitos = bruto.toString().replace(/^0+/, "").length;
      const aprox = digitos > 15 ? "  (uiAmount aproximado: bruto tem mais de 15 digitos)" : "";
      console.log(
        `        ${nome.padEnd(4)}     bruto "${b.uiTokenAmount.amount}"  exato ${formatarBruto(bruto, dec)}  uiAmount ${b.uiTokenAmount.uiAmount ?? "null"}${aprox}`,
      );
      return bruto;
    };

    const bPre = lado("pre", par.pre, meta.preBalances[par.indice], "antes");
    const bPost = lado("post", par.post, meta.postBalances[par.indice], "depois");
    if (bPre !== null && bPost !== null) {
      const d = bPost - bPre;
      console.log(`        delta    bruto ${comSinal(d)}  exato ${d > 0n ? "+" : ""}${formatarBruto(d, dec)}`);
    } else {
      console.log("        delta    nao calculado: falta um dos lados");
    }
  }
  console.log("  obs: token balances so cobrem saldo de contas de token. Delegate, authority,");
  console.log("       close de outras contas etc. NAO aparecem aqui.");
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const assinatura = lerAssinatura(process.argv);
  if (!assinatura.ok) {
    console.error(assinatura.erro);
    return EXIT_ENTRADA;
  }
  const config = lerConfig(process.env);
  if (!config.ok) {
    console.error(config.erro);
    return EXIT_ENTRADA;
  }
  const { rpcUrl, commitment } = config.valor;
  const conexao = new Connection(rpcUrl, { commitment, disableRetryOnRateLimit: true });

  let genesis: string;
  try {
    genesis = await conexao.getGenesisHash();
  } catch (erro) {
    console.error(`Falha de RPC ao conectar: ${redigir(mensagemDe(erro), rpcUrl)}`);
    return EXIT_RPC;
  }
  if (genesis !== GENESIS_MAINNET) {
    console.error("VETO_RPC_URL respondeu, mas nao e mainnet (genesis hash diferente). Consulta recusada.");
    return EXIT_ENTRADA;
  }

  let tx: VersionedTransactionResponse | null;
  try {
    // Sem este parametro o RPC so devolve tx legacy e recusa as versionadas.
    tx = await conexao.getTransaction(assinatura.valor, {
      commitment,
      maxSupportedTransactionVersion: MAX_VERSAO_SUPORTADA,
    });
  } catch (erro) {
    const texto = redigir(mensagemDe(erro), rpcUrl);
    const versao = /Transaction version \((\d+)\) is not supported/.exec(texto);
    if (versao !== null) {
      console.error(
        `A transacao existe, mas esta na versao ${versao[1]}; este SDK so le ate a versao ${MAX_VERSAO_SUPORTADA}.`,
      );
    } else {
      console.error(`Falha de RPC ao buscar a transacao: ${texto}`);
    }
    return EXIT_RPC;
  }
  if (tx === null) {
    console.error(
      `Transacao nao encontrada em mainnet (commitment ${commitment}): ${assinatura.valor}\n` +
        "Pode nao existir, ser recente demais para este commitment, ou estar fora do historico do RPC.",
    );
    return EXIT_NAO_ENCONTRADA;
  }

  const { contas, avisos } = resolverContas(tx);
  imprimirResumo(tx, commitment);
  imprimirContas(contas, avisos);
  imprimirExternas(tx, contas);
  imprimirInternas(tx, contas);
  imprimirSaldosSol(tx, contas);
  imprimirSaldosToken(tx, contas);

  if (tx.meta === null) return EXIT_SEM_META;
  return tx.meta.err === null ? EXIT_OK : EXIT_TX_FALHOU;
}

process.exitCode = await main();
