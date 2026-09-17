# SETUP — VETO

Como o ambiente foi montado, por quê, e como verificar que está funcionando.

Este documento cobre só a fundação. A especificação do produto está em
`CLAUDE.md` e em `/docs`.

---

## 1. Pré-requisitos

| Ferramenta | Mínimo | Verificado nesta máquina |
|---|---|---|
| Node.js | 20 | v26.7.0 |
| pnpm | 10 | 12.4.2 |
| git | — | 2.52.0 |

O `engines` do `package.json` exige Node >= 20 e o `.npmrc` tem
`engine-strict=true`, o que transforma isso em erro de instalação, não
em aviso ignorado.

> **Nota honesta:** Node 20 saiu de suporte em abril de 2026. O mínimo
> está em 20 porque é o que o `CLAUDE.md` define, mas para desenvolvimento
> use 22 ou mais recente.

### pnpm não vinha instalado

O `corepack`, que costumava trazer o pnpm junto com o Node, foi removido
das versões recentes. A instalação foi feita globalmente:

```bash
npm install -g pnpm
```

É a única alteração feita fora da pasta do projeto.

---

## 2. O que foi instalado e por quê

### Dependências de produção

| Pacote | Versão | Para que serve no VETO |
|---|---|---|
| `@solana/web3.js` | `^1.99.0` | `Connection.simulateTransaction()` com `accounts` e `innerInstructions` — é a etapa 3 inteira. Também `VersionedTransaction`, `PublicKey`, `AccountInfo`. |
| `@solana/spl-token` | `^0.4.15` | `ACCOUNT_SIZE`, `AccountLayout`, `TOKEN_PROGRAM_ID`. Usado para **decodificar bytes offline**, não para chamar RPC. É o "layout fixo, sem IDL" do `veto-construcao.md`. |
| `bs58` | `^6.0.0` | Endereços Solana são base58. A verificação de proveniência busca a string base58 nos `contextChunks`, inclusive por prefixo/sufixo para endereço truncado. |
| `zod` | `^4.6.5` | Validação de fronteira: `ActionContext` vindo do cliente, `ToolManifest` escrito à mão, `TaskEnvelope` saído de um LLM. `z.infer` gera o tipo TS a partir do schema — uma fonte de verdade só. |

> **A versão do `@solana/web3.js` está fixada em `^1.x` de propósito.** A
> linha 2.x é uma reescrita com API incompatível (renomeada para
> `@solana/kit`) e **não tem `Connection` nem `VersionedTransaction`**, que
> é o que os documentos de spec usam. Não atualizar para 2.x sem revisar a
> arquitetura inteira.

### Dependências de desenvolvimento

| Pacote | Versão | Para que serve |
|---|---|---|
| `typescript` | `^7.0.2` | Compilador e type checker. Só roda em `pnpm typecheck` — não está no caminho de execução. |
| `vitest` | `^5.0.1` | Runner de teste. Escolhido por rodar ESM + TypeScript sem configuração e por comparar `bigint` corretamente no `expect` — o que importa, já que todo valor de token é `bigint`. |
| `@vitest/coverage-v8` | `^5.0.1` | Cobertura via profiler nativo do V8, sem instrumentar o código. |
| `tsx` | `^4.23.13` | Executa `.ts` direto, sem passo de build. Ver seção 5. |
| `@types/node` | `^22.20.3` | Tipos de `Buffer`, `process`, `node:crypto`. Decodificação de conta é manipulação de `Buffer` o tempo todo. |

### Scripts de instalação negados

`pnpm-workspace.yaml` declara quais dependências podem executar
`postinstall`. O pnpm **nega por padrão** e exige decisão explícita —
`postinstall` é o vetor clássico de ataque de supply chain.

| Pacote | Permitido | Motivo |
|---|---|---|
| `esbuild` | **sim** | O `install.js` posiciona o binário nativo da plataforma. Sem ele, `tsx` e `vitest` não rodam. |
| `bigint-buffer` | não | Addon nativo opcional. Há fallback em JS puro, correto e suficiente. |
| `bufferutil` | não | Otimização nativa opcional de WebSocket. Há fallback em JS puro. |
| `utf-8-validate` | não | Idem. |

Se algum dia aparecer no stderr um aviso
`bigint: Failed to load bindings, pure JS will be used` — é esperado e
inofensivo, consequência direta da linha `bigint-buffer: false`.

---

## 3. Arquivos de configuração

| Arquivo | O que decide |
|---|---|
| `package.json` | ESM (`"type": "module"`), Node >= 20, versão travada do pnpm, `"private": true` para impedir publicação acidental. |
| `tsconfig.json` | Rigor do compilador. Cada opção não-óbvia tem comentário no próprio arquivo. |
| `vitest.config.ts` | Ambiente `node`, `globals: false` (imports explícitos), timeout de 5s, cobertura via v8. |
| `.npmrc` | `engine-strict=true`. |
| `pnpm-workspace.yaml` | Política de scripts de instalação (tabela acima). |
| `.gitignore` | `node_modules/`, `.env`, `dist/`, `coverage/`, lixo de SO e editor. |
| `.env.example` | Contrato das variáveis de ambiente, sem valor real. |

### As opções de `tsconfig.json` que importam

`strict: true` liga oito flags. Estas são as que ele **não** liga e que
foram ativadas à mão:

- **`noUncheckedIndexedAccess`** — a mais importante aqui. Faz `array[0]`
  ter tipo `T | undefined`. Você vai ler bytes de conta SPL em offsets
  fixos; é essa flag que impede um `buffer[164]` fora do limite de virar
  `undefined` silencioso.
- **`exactOptionalPropertyTypes`** — `{ delegate?: string }` deixa de
  aceitar `{ delegate: undefined }`. No `EffectSet`, "campo ausente" e
  "campo presente valendo nada" são coisas diferentes: repare que
  `authorityChanges.from` é `string | null`, e `null` ali é um valor, não
  uma ausência.
- **`noFallthroughCasesInSwitch`** — protege o `switch` sobre os 8
  `EffectType`.
- **`verbatimModuleSyntax`** — obriga `import type` para o que some no
  build.
- **`noUnusedLocals` / `noUnusedParameters`** — erro vira erro.

### Sobre imports: a extensão `.js` não é engano

`moduleResolution` está em `nodenext`, o que faz o TypeScript resolver
módulos exatamente como o Node faz em runtime. A consequência é que
import relativo precisa de extensão, e a extensão é `.js` mesmo apontando
para um arquivo `.ts`:

```ts
import type { EffectSet } from "../tipos/efeitos.js";  // o arquivo é efeitos.ts
```

É o padrão de ESM + TypeScript. `tsc`, `tsx` e `vitest` entendem os três.

### Por que não há alias de caminho (`@/...`)

`tsc` **não reescreve** aliases no código emitido — `import "@/tipos"` sai
literal no `dist/` e o Node não resolve. Aliases exigiriam bundler ou
loader extra em produção. Como a estrutura tem um nível só de
profundidade (`src/normalizacao/` → `../tipos/`), o ganho seria quase
zero. Import relativo, então.

---

## 4. Estrutura de pastas

```
.
├── src/
│   ├── captura/        # wrapper do agente, ActionContext, marcação de
│   │                   # proveniência dos contextChunks  [componente 1]
│   ├── normalizacao/   # tx -> EffectSet. simulateTransaction, leitura do
│   │                   # estado anterior, diff, decodificação de conta SPL
│   │                   # por offset fixo                 [componente 2]
│   ├── avaliacao/      # manifestos, envelope de tarefa, proveniência,
│   │                   # magnitude, agregado -> Verdict  [componente 3]
│   ├── gate/           # Verdict -> allow / flag / deny  [componente 4]
│   └── tipos/          # interfaces compartilhadas: Effect, EffectSet,
│                       # ToolManifest, Verdict, Finding, ActionContext
├── test/
│   ├── fixtures/       # transações reais gravadas da mainnet, em JSON.
│   │                   # Fonte de verdade dos testes. Sem rede.
│   └── ambiente.test.ts
├── docs/               # especificação
├── CLAUDE.md           # instruções e decisões de arquitetura
└── SETUP.md            # este arquivo
```

**Convenção de teste:** `test/` espelha `src/`. Um módulo em
`src/normalizacao/diff.ts` tem teste em `test/normalizacao/diff.test.ts`.

**Convenção de fixture:** nada de rede dentro de teste. Transação real
vira JSON gravado em `test/fixtures/` e o teste lê o arquivo. Um teste que
passe de 5 segundos estoura o `testTimeout` — o que normalmente significa
que alguém colocou uma chamada de RPC onde não devia.

Os arquivos `.gitkeep` existem só porque git não versiona diretório
vazio. Podem ser apagados quando cada pasta receber código de verdade.

---

## 5. Os scripts

```bash
pnpm dev            # tsx watch --env-file=.env src/index.ts
pnpm test           # vitest run
pnpm test:watch     # vitest  (modo interativo)
pnpm test:coverage  # vitest run --coverage
pnpm typecheck      # tsc --noEmit
```

### `pnpm dev` — e por que ele falha agora

Executa `src/index.ts` com recarga a cada alteração. **`src/index.ts`
ainda não existe** (por decisão: nada de código do VETO até a fundação
estar fechada), então este script vai errar até a etapa 3 criar o
arquivo. É esperado.

O `--env-file=.env` usa o carregamento **nativo** do Node — não há
`dotenv` no projeto e não precisa haver. Se o `.env` não existir, o
comando falha de forma explícita, o que é o comportamento desejado: o
`CLAUDE.md` diz que erro nunca é engolido.

### `pnpm test` e `pnpm typecheck` são coisas diferentes

Isto não é redundância, é divisão de trabalho, e vale entender:

`tsx` e `vitest` transpilam com **esbuild**, que **apaga os tipos sem
verificá-los**. Os dois rodam código com erro de tipo sem reclamar. Quem
verifica tipo é `tsc --noEmit`, e só ele.

```
pnpm dev / pnpm test  ->  rápido, ciclo curto, feedback imediato
pnpm typecheck        ->  portão de qualidade, antes de commit e no CI
```

Rode os dois antes de dar qualquer coisa por pronta.

---

## 6. O que preencher no `.env`

```bash
cp .env.example .env
```

| Variável | Obrigatória | Onde conseguir |
|---|---|---|
| `VETO_RPC_URL` | sim | [dashboard.helius.dev](https://dashboard.helius.dev) → conta gratuita → **Endpoints** → copiar a URL de **mainnet**. Formato: `https://mainnet.helius-rpc.com/?api-key=...` |
| `VETO_RPC_URL_DEVNET` | não (por ora) | Mesmo painel, endpoint de devnet. Necessária na etapa 1, o agente vulnerável. |
| `VETO_RPC_COMMITMENT` | não | Deixe `confirmed`. `processed` é mais rápido e menos estável; `finalized` é lento demais para o loop do agente. |

**Por que Helius e não o RPC público.** O `api.mainnet-beta.solana.com`
aplica rate limit agressivo e **não garante `innerInstructions` nem o
retorno de `accounts` na simulação** — que são exatamente os dois campos
de que a etapa 3 depende. O plano gratuito da Helius resolve o POC
inteiro.

**Por que a URL inteira é segredo.** A API key vem embutida na query
string. Não é "a chave é segredo e a URL não" — a URL *é* a chave. Por
isso `.env` está no `.gitignore` e nunca deve aparecer em log, print ou
mensagem de erro.

> Item aberto do `veto-status.md`, ainda não confirmado:
> `simulateTransaction` devolvendo estado de conta e inner instructions
> como esperado. **Confirmar contra a Helius antes de escrever o
> normalizador.**

---

## 7. Como verificar que está tudo funcionando

Do zero, numa máquina nova:

```bash
pnpm install
pnpm typecheck
pnpm test
```

O esperado:

```
$ pnpm typecheck
(nenhuma saída, código de saída 0)

$ pnpm test
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

### O que o teste de fumaça prova

`test/ambiente.test.ts` não testa nada do VETO. Ele prova quatro coisas
da fundação, cada uma escolhida por ser um pressuposto do projeto:

1. **`expect` compara `bigint` corretamente** — inclusive `u64::MAX`, que
   é o sinal de allowance ilimitada. Se o runner não comparasse `bigint`
   direito, todo teste de saldo seria falso-positivo silencioso.
2. **`AccountLayout` decodifica uma conta SPL a partir de bytes crus**,
   offline, com `ACCOUNT_SIZE === 165` — é o corte de escopo central do
   projeto funcionando.
3. **Round-trip de endereço em base58** — base da verificação de
   proveniência.
4. **`zod` rejeita um valor fora do enum de `provenance`** — validação de
   fronteira de pé.

Pode apagar este arquivo quando o normalizador tiver teste próprio.

### Verificação extra: o rigor está mesmo ligado

Configuração estrita que não dá erro não está ligada. Para conferir, crie
um arquivo temporário:

```ts
// test/__tmp.ts
const bytes: number[] = [1, 2, 3];
const b: number = bytes[164];              // deve falhar
type Alvo = { delegate?: string };
const a: Alvo = { delegate: undefined };   // deve falhar
export { b, a };
```

`pnpm typecheck` deve acusar **dois** erros — `TS2322` e `TS2375`. Se
passar limpo, o `tsconfig.json` não está sendo lido. Apague o arquivo
depois.

---

## 8. Estado atual e próximo passo

**Pronto:** gerenciador de pacote, dependências, TypeScript estrito,
runner de teste, estrutura de pastas, contrato de ambiente.

**Nenhuma linha de código do VETO foi escrita.** `src/` está vazio por
decisão — a fundação vem antes.

**Próximo:** etapa 3 do `veto-construcao.md`, o normalizador
(`src/normalizacao/`). `simulateTransaction` com `accounts` e
`innerInstructions`, leitura do estado anterior das mesmas contas, diff,
saída em `EffectSet`. Testável isolado com transações reais gravadas em
`test/fixtures/`.

Antes disso, três coisas a resolver, nesta ordem:

1. Confirmar contra a Helius que `simulateTransaction` devolve estado de
   conta e inner instructions como a spec assume. **Bloqueia a etapa 3.**
2. Definir o `EffectSet` e o vocabulário de 8 efeitos em `src/tipos/` —
   é o contrato que todo o resto consome.
3. Gravar as primeiras fixtures de mainnet: um transfer simples, um swap
   no Jupiter e, principalmente, um `approve` com `u64::MAX`.

### Ainda não configurado, de propósito

| Item | Por que ficou de fora |
|---|---|
| `git init` | Não foi pedido. O `.gitignore` já está pronto para quando for. |
| Script de `build` | Ninguém consome `dist/` ainda. Quando precisar: `tsconfig.build.json` com `outDir`, sem `noEmit`, e só `src/` no `include`. |
| Linter / formatador | Nenhum foi pedido. `tsc` estrito já pega a classe de erro que importa. |
| Postgres + Drizzle | O `CLAUDE.md` marca como fase posterior — só a verificação D (agregado) precisa de persistência. |
| CI | Sem repositório git ainda. Quando houver: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`. |
