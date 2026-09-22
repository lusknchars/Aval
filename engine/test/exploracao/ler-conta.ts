/**
 * Script de exploracao: le os metadados de uma conta em devnet.
 *
 *   pnpm exec tsx --env-file=.env test/exploracao/ler-conta.ts <endereco>
 *
 * Nao e teste (nao termina em .test.ts) e nao e codigo do VETO.
 * So valida conexao RPC e mostra o que getAccountInfo devolve.
 *
 * Codigos de saida:
 *   0  conta lida
 *   1  entrada ou configuracao invalida (inclui RPC que nao e devnet)
 *   2  RPC respondeu, mas a conta nao existe
 *   3  falha de RPC (rede, autenticacao, rate limit...)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";

// Genesis hash e fixo por cluster. Serve de prova de que o RPC e devnet.
const GENESIS_DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const EXIT_OK = 0;
const EXIT_ENTRADA = 1;
const EXIT_INEXISTENTE = 2;
const EXIT_RPC = 3;

const esquemaUrl = z.url({ protocol: /^https?$/ });
const esquemaCommitment = z.enum(["processed", "confirmed", "finalized"]);

type Config = {
  rpcUrl: string;
  commitment: z.infer<typeof esquemaCommitment>;
};

type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };

// Nenhuma mensagem de erro repete o valor recebido: a URL carrega a chave.
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

function lerEndereco(argv: readonly string[]): Resultado<PublicKey> {
  const entrada = argv[2];
  if (entrada === undefined || argv.length > 3) {
    return { ok: false, erro: "Uso: ler-conta.ts <endereco-base58>" };
  }
  try {
    // Exige base58 que decodifica para exatamente 32 bytes.
    return { ok: true, valor: new PublicKey(entrada) };
  } catch {
    return { ok: false, erro: `Endereco invalido: "${entrada}" nao e uma chave publica base58 de 32 bytes.` };
  }
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

async function main(): Promise<number> {
  const endereco = lerEndereco(process.argv);
  if (!endereco.ok) {
    console.error(endereco.erro);
    return EXIT_ENTRADA;
  }

  const config = lerConfig(process.env);
  if (!config.ok) {
    console.error(config.erro);
    return EXIT_ENTRADA;
  }
  const { rpcUrl, commitment } = config.valor;

  // Sem retry silencioso em 429: o erro aparece em vez de o script travar.
  const conexao = new Connection(rpcUrl, { commitment, disableRetryOnRateLimit: true });

  let genesis: string;
  try {
    genesis = await conexao.getGenesisHash();
  } catch (erro) {
    console.error(`Falha de RPC ao conectar: ${redigir(mensagemDe(erro), rpcUrl)}`);
    return EXIT_RPC;
  }
  if (genesis !== GENESIS_DEVNET) {
    console.error("VETO_RPC_URL_DEVNET respondeu, mas nao e devnet (genesis hash diferente). Leitura recusada.");
    return EXIT_ENTRADA;
  }

  let info: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    info = await conexao.getAccountInfo(endereco.valor, { commitment });
  } catch (erro) {
    console.error(`Falha de RPC ao ler a conta: ${redigir(mensagemDe(erro), rpcUrl)}`);
    return EXIT_RPC;
  }

  if (info === null) {
    console.error(`Conta nao existe em devnet (commitment ${commitment}): ${endereco.valor.toBase58()}`);
    return EXIT_INEXISTENTE;
  }

  console.log(`endereco:   ${endereco.valor.toBase58()}`);
  console.log(`lamports:   ${info.lamports}`);
  console.log(`owner:      ${info.owner.toBase58()}`);
  console.log(`data:       ${info.data.length} bytes`);
  console.log(`executable: ${info.executable}`);

  // lamports chega como number (JSON.parse no SDK). Acima de 2^53-1 ja
  // chegou arredondado -- converter para bigint aqui nao recupera nada.
  if (!Number.isSafeInteger(info.lamports)) {
    console.error("aviso: lamports acima de Number.MAX_SAFE_INTEGER; o valor acima pode estar impreciso.");
  }

  return EXIT_OK;
}

process.exitCode = await main();
