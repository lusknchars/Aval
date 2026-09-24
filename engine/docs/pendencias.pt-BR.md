# Pendências por bloco

*Registrado durante a construção, não escrito depois.*

> Tradução de `pending.md`. O arquivo em inglês é a fonte de verdade; este
> aqui é cópia de leitura e pode ficar desatualizado.

Urgência: **B** bloqueia a peça seguinte · **P** o produto não fica completo
sem · **D** dívida conhecida, pode esperar.

---

## Bloco 1 — Tipos (`src/types/`) — *construído*

O que existe: vocabulário fechado de 8 efeitos, `EffectSet`, `ActionContext`
com proveniência, `ToolManifest` com validação de referências, `Verdict`.

| # | Item | Urgência |
|---|---|---|
| 1.1 | **Conjunto de efeitos sempre-críticos** (`AUTHORITY_CHANGE`, `OWNER_CHANGE`, `DELEGATE_GRANT` ilimitado). É a rede de segurança embaixo de um `mustNot` incompleto, e a única verificação que funciona sem manifesto nenhum. Não existe. | **P** |
| 1.2 | **Resolvedor de `ArgRef`** — resolver `arg:from` contra os argumentos do tool call, falhando de forma explícita. A validação estática existe; a resolução em runtime não. | **B** |
| 1.3 | **Regra de combinação (`decide`)** — teto de severidade → `allow`/`flag`/`deny`. Tipos e limiares existem; a função pertence à camada de avaliação. | **P** |
| 1.4 | ~~Serialização de bigint~~ — **resolvido no bloco 2**: string decimal nas fixtures. | feito |
| 1.5 | **Composição do `policyVersion`** — hoje é uma string livre. Precisa ser derivada das versões dos manifestos + limiares + versão do classificador. | **D** |
| 1.6 | `MAX_TOLERANCE = 0.10` é calibração arbitrária, escolhida sem dado nenhum. Medir o slippage p99 de um swap legítimo. | **D** |
| 1.7 | Severidade própria para **slippage extremo** — a spec pede; hoje a tolerância é binária (dentro passa, fora vira achado). | **D** |
| 1.8 | Exceção explícita para ferramenta que legitimamente precise de mais folga que o teto. | **D** |

---

## Bloco 2 — RPC e fixtures (`src/normalization/`) — *construído*

O que existe: `rpc.ts` com a interface `RpcClient` e implementação sobre
web3.js; `fixture.ts` com o formato gravado e um cliente falso;
`src/cli/record-fixture.ts`; três fixtures gravadas.

| # | Item | Urgência |
|---|---|---|
| 2.1 | ~~Gravador de fixtures~~ | feito |
| 2.2 | ~~Fixtures mínimas~~ — `transfer-sol`, `create-ata`, `unlimited-approve` gravadas. | feito |
| 2.3 | ~~`RpcClient` falso~~ | feito |
| 2.4 | **`lamportsExact` não é consumido por ninguém.** Quando um efeito for calculado sobre valor inexato, tem que virar achado de `coverage`. Hoje desaparece. | **P** |
| 2.5 | **Falha parcial em `readLookupTables`** — hoje o primeiro erro derruba a leitura inteira. Resolver o que der e marcar cobertura incompleta provavelmente é o certo. | **P** |
| 2.6 | **Política de timeout e retry** — não existe. Precisa ser explícita: quanto tempo antes de degradar para `unavailable`. | **P** |
| 2.7 | **Orçamento de latência não medido.** Resolver lookup tables é uma ida extra ao RPC; a meta é decidir abaixo de 100 ms. Nenhuma medição foi feita. | **P** |
| 2.8 | `identifyNetwork` existe mas nunca é chamado automaticamente. Decidir se é obrigatório na construção do cliente. | **D** |
| 2.9 | Comportamento sob **rate limit** (429): hoje `disableRetryOnRateLimit: true` faz o erro aparecer. O que o gate faz nesse caso está indefinido. | **P** |
| 2.10 | **Nenhuma fixture usa Address Lookup Table.** As fixtures são construídas por nós em devnet; transação histórica de mainnet não dá para simular hoje, porque o estado mudou. A resolução de contas vai precisar de uma fixture de formato diferente: mensagem e conteúdo das tabelas, sem pós-estado. | **B** |

---

## Bloco 3 — Decodificação SPL (`spl.ts`) — *não começou*

Ler `amount`, `owner`, `delegate`, `delegatedAmount`, `state` e
`closeAuthority` dos bytes, em offsets fixos, sem IDL.

| # | Item | Urgência |
|---|---|---|
| 3.1 | **Token-2022 não coberto.** Mesmo layout base, mas as extensões mudam o tamanho da conta. Decisão: cobrir só o Token Program clássico e registrar Token-2022 como "não coberto" em `coverage`. | **P** |
| 3.2 | **Stake e vote fora de escopo.** `AUTHORITY_CHANGE` inclui autoridades de stake e de upgrade de programa; nenhuma será lida no início. Marcar como não coberto. | **P** |
| 3.3 | **`decimals` do mint** — necessário para a unidade `decimal` do manifesto. Exige ler a conta do mint, o que é mais uma ida ao RPC. Cachear? | **B** |
| 3.4 | Conta de token **fechada** volta como `null` no pós-estado. Distinguir isso de "não observada". | **B** |

---

## Bloco 4 — Resolução de contas (`accounts.ts`) — *não começou*

| # | Item | Urgência |
|---|---|---|
| 4.1 | **Resolver lookup tables antes da assinatura** — verificado que funciona (tabela `Hu5cMUbi…` índice 111 devolve a mesma conta que a transação executada mostrava). Falta implementar. | **B** |
| 4.2 | **Montar a lista de contas a observar.** É o que define a cobertura: o que não for pedido nunca aparece na simulação. | **B** |
| 4.3 | **Escopo `args_plus_derived`** — exige derivar PDAs e ATAs dos argumentos. Sem isso, o escopo de contas do manifesto não é verificável. | **P** |
| 4.4 | **Rebaixamento de writable** — a mensagem declara writable; o runtime pode rebaixar. A flag da mensagem não é verdade absoluta. | **D** |
| 4.5 | **Teto de contas.** Uma transação pode referenciar ~256 contas com lookup tables. Pedir todas custa; pedir menos cria ponto cego. Decidir o limite e o que acontece ao passar dele. | **P** |

---

## Bloco 5 — Diff (`diff.ts`) — *não começou · a peça grande*

| # | Item | Urgência |
|---|---|---|
| 5.1 | **Wrapped SOL contado duas vezes.** Observado num swap real: o delta de lamports e o delta de token na mesma conta são idênticos. Precisa de regra explícita. | **B** |
| 5.2 | **Atribuição de taxa e rent.** O pós-estado já desconta a taxa do fee payer (verificado). Isso não pode virar um `BALANCE_DECREASE` atribuído à intenção do usuário. | **B** |
| 5.3 | **Detectar `ACCOUNT_CREATE` e `ACCOUNT_CLOSE`** pelas transições `null → existe` e `existe → null`. Depende do 3.4. | **B** |
| 5.4 | **`PROGRAM_INVOKE` a partir das `innerInstructions`** — duas formas possíveis na resposta (`jsonParsed` e compilada). O SDK instalado só valida a primeira. | **P** |
| 5.5 | **Limiar de ruído.** Nem toda mudança de lamport é efeito relevante. Definir o que é ruído sem criar ponto cego. | **P** |
| 5.6 | **Allowance ilimitada** — `delegatedAmount == u64::MAX` precisa virar sinal próprio, não só mais um `DELEGATE_GRANT`. | **P** |

---

## Bloco 6 — Orquestração (`simulate.ts`) — *não começou*

| # | Item | Urgência |
|---|---|---|
| 6.1 | Montar o `EffectSet` completo: efeitos + `slot` + `simulation` + `coverage`. | **B** |
| 6.2 | **Degradação explícita**: RPC fora, simulação recusada, cobertura incompleta — cada um com seu caminho, nenhum colapsando numa lista vazia de efeitos. | **B** |
| 6.3 | `minContextSlot` entre a leitura anterior e a simulação. Decidir se é obrigatório. | **D** |

---

## Bloco 7 — CLI (`src/cli/`) — *parcialmente construído*

| # | Item | Urgência |
|---|---|---|
| 7.1 | **`inspect`** — receber uma assinatura de mainnet ou uma transação em base64 e imprimir um `EffectSet` legível. | **P** |
| 7.2 | ~~`record-fixture`~~ | feito |
| 7.3 | **Saída em JSON** (`--json`) para scripts de pesquisa. | **P** |
| 7.4 | **Nunca imprimir a URL do RPC nem a api-key.** Resolvido no módulo de RPC; a CLI precisa herdar a disciplina. | **P** |
| 7.5 | Códigos de saída distintos por resultado, como nos scripts de exploração. | **D** |
| 7.6 | Decidir se isso vira um binário publicável (`bin` no `package.json`) ou continua em `tsx`. | **D** |

---

## Transversal

| # | Item | Urgência |
|---|---|---|
| T.1 | **A configuração do cliente não tem validação nenhuma.** É o único lugar onde um erro *desliga um detector inteiro sem avisar* (padrão largo demais no `SourceTrust`). Defesa: exigir hostname completo, mais uma **pré-visualização** do que o padrão casaria contra tráfego real. | **P** |
| T.2 | **A costura entre o manifesto e a ferramenta real do cliente.** Ninguém digita nada errado e mesmo assim não bate. Referência não resolvida tem que virar achado de `coverage`. | **P** |
| T.3 | **Endereços da allowlist nunca são verificados on-chain.** Endereço digitado errado quase nunca existe — dá para detectar na entrada. | **D** |
| T.4 | **Nenhuma medição de desempenho em lugar nenhum.** | **P** |
| T.5 | **Sem CI.** `pnpm typecheck && pnpm test` deveria rodar a cada push. | **D** |
| T.6 | Os três documentos de especificação em `docs/` estão em português; todo o resto está em inglês. Decidir se traduz. | **D** |

---

**44 itens**: 6 feitos, 11 marcados **B**, 18 **P**, 9 **D**.

Os 11 bloqueadores estão concentrados nos blocos 3, 4, 5 e 6 — o caminho direto
até o `EffectSet`. O único bloqueador fora dessa linha é o **2.10**, a fixture
com lookup table, de que o bloco 4 vai precisar.
