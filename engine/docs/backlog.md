# Feature backlog

Everything on the table, as features rather than as construction notes.
`docs/pending.md` tracks defects and gaps found while building a block;
this is the forward list: what the product does not do yet, why it matters,
and what it would cost.

**Nothing here is prioritised.** The order inside each section is roughly by
how much it unblocks, not by when it should happen.

Dependency marks: **[bloqueado]** waits on something outside the code ·
**[decisão]** waits on a choice · **[livre]** can start now.

---

## O que já é funcional

Built, tested and measured against ground truth rather than against itself.

| | Verified how |
|---|---|
| **Normalizador** — transação não assinada → `EffectSet` | taxa lida dos bytes bate **200/200** com o que a rede cobrou; resolução de contas bate índice por índice com o SDK; **375/375** efeitos de tráfego real conformam ao contrato de forma |
| **Vocabulário de 9 efeitos + contrato de forma** | 26 transições montadas byte a byte, os 9 tipos alcançáveis |
| **Camada de avaliação** — veredito determinístico | 34/35 ALLOW em declaração honesta de mainnet; 24/24 e 24/24 nos dois modos de mentira |
| **9 manifestos** | teste que recusa manifesto quebrado |
| **Captura** — carimbo na porta, interceptação na assinatura | funciona com o agente de demonstração |
| **Gate** — `allow` assina, `deny` recusa, `flag` assina e registra | o assinador nunca é chamado num DENY; testado em fixture real |
| **Autorização de uso único** amarrada ao digest | transação B apresentada com o bilhete da A → recusada; replay → recusado |
| **Identificador de ferramenta** normalizado | `SolanaTransferTool` + `mint` → manifesto de token; sem `mint` → SOL; `stake` continua desconhecido |
| **Registro + fila de revisão** | retrospecto calculado com o `decide` real; aprovar muda o próximo veredito (`policyVersion` muda sozinho) |
| **Deny-list** aprovada por humano | crítico, vence allowlist, qualquer papel do endereço |
| **Check E** (conteúdo) | rótulo sobe, nunca desce; só quando o trecho rotulado contribuiu o destino |
| **Juiz** — adaptador com mão única no tipo | não existe forma de dizer "allow"; indisponível vira finding, não silêncio |
| **Camadas externas** por URL | juiz, guard, OCR, corretor: stub no-op quando ausente; toda falha vira `coverage.capture_degraded` |
| **Demo** — página, agente real, fila de revisão, CLIs | |

**363 testes, typecheck limpo.**

## O que impede de chamar isso de produto

Duas coisas.

~~**Nada segura uma assinatura.**~~ *Feito: o gate, com autorização de uso
único verificada no assinador.*

**Nenhuma integração com framework que um cliente rode.** A captura funciona
com o nosso agente de demonstração, que fomos nós que escrevemos. As camadas
externas (juiz, guard, OCR, corretor) já têm tomada e stub; o que falta é a
captura dentro do framework do cliente.

**9 manifestos para 60+ ferramentas.** Numa integração real quase toda chamada
cairia em `coverage.no_manifest`.

Tudo o mais nas seções abaixo melhora a detecção. Essas três decidem se existe
produto.

---

## Ordem sugerida para os primeiros componentes funcionais

Aimed at the shortest path to "an agent operator installs this and it actually
refuses a bad transaction". Everything outside this list improves detection
without changing whether the thing works.

### Fase 0 — destravar, dias
1. **F1 · Créditos no modelo.** Não é código. Destrava o caminho principal da
   demo.
2. **A4 · Normalização de identificador de ferramenta.** Barato e bloqueia
   tudo depois: sem isso nenhum manifesto casa numa integração real e tudo
   degrada para `no_manifest`.

### Fase 1 — o gate, que é o que transforma parecer em portão
3. **A2 · O gate.** Uma interface que embrulha a função de assinatura, roda a
   pipeline e recusa no DENY. É a peça que falta para o VETO *fazer* algo em
   vez de *dizer* algo.
4. **A3 · Autorização de uso único amarrada ao digest.** Completa o gate: o
   assinador recusa qualquer payload cujo hash não bate com o aprovado. Hoje a
   ligação entre "o VETO disse sim" e "estes bytes foram assinados" é por
   convenção.
5. **E5 · Fixtures das operações perigosas.** Grava em devnet o congelamento,
   a troca de dono e a queima produzindo efeito real. Barato, e é o que prova
   que os tipos novos funcionam ponta a ponta.

### Fase 2 — a integração que torna real
6. **Decidir qual framework instrumentar.** Solana Agent Kit é o mais
   documentado; o repo do GOAT está arquivado. **Essa decisão é sua.**
7. **A1 · Captura em produção** naquele framework.
8. **C1 · Manifestos das primitivas de DeFi** — stake, lend, perps — na ordem
   em que o dinheiro dos agentes está. Sem eles a integração acusa tudo.

### Fase 3 — o que permite afirmar que funciona
9. **E1 · Suíte adversarial.** Transforma "acurácia" de opinião em número, e é
   o ground truth que falta do lado do ataque.
10. **E3 · Metodologia de medição** — atacado × identificado × confirmado,
    falso positivo, conclusão de tarefa legítima.

### Fase 4 — o que faz o sistema melhorar sozinho
11. **Persistência.** Um armazenamento de vereditos. Destrava duas coisas de
    uma vez: o agregado (B1) e o juiz que propõe política (B6), que dividem o
    mesmo corpus.
12. **B6 · Juiz que propõe política.** A resposta certa para "FLAG em quase
    tudo": em vez de filtrar o ruído, ele propõe os manifestos e as entradas de
    allowlist que fariam o ruído desaparecer — e um humano aprova vendo o que
    cada proposta teria deixado passar no passado.

### Deliberadamente fora das três primeiras fases
**B1 agregado**, **B2 envelope** e **B3 input guard** melhoram a detecção e não
mudam se a coisa funciona. O agregado precisa de persistência, o envelope
precisa de uma chamada de modelo por tarefa, e o input guard é uma camada que
soma — nenhum deles é caminho crítico para o primeiro componente funcional.

---

## A — As duas camadas que não existem

The evaluation engine is built and measured. These are the pieces around it,
and without them there is no product — only a library that answers correctly
when somebody hands it the right question.

### A1 · Camada de captura em produção **[decisão]**
`src/capture/` exists and works for our own demo agent. What does not exist is
an integration with a framework a customer actually runs. The rule that
matters is already implemented and must survive the port: the agent never
declares where information came from — whoever calls the tool stamps it.

*Decide first:* which framework to instrument. Solana Agent Kit is the best
documented and has 60+ tools; GOAT's repo is archived.

### A2 · O gate **[feito]**
The verdict is computed and displayed; nothing holds a signature back.
`src/gate/` is an empty directory. The enforcement point is the wallet's
signing function, and the agent must not be able to route around it without
removing the wallet.

### A3 · Autorização de uso único amarrada ao digest **[feito]**
*Ideia vinda do veto-lab.* We already put `messageDigest` on the verdict; the
other half is missing. An ALLOW should mint a single-use MAC over that exact
digest, and the signer should refuse any payload whose hash differs. That
closes the gap between "VETO said yes" and "these bytes got signed", which
today is closed by convention only. Chain-agnostic.

### A4 · Normalização de identificador de ferramenta **[feito]**
`manifestFor` is an exact-name lookup. The same `transfer` appears in Solana
Agent Kit as `transfer`, `TRANSFER`, `TRANSFER_ACTION` and (v1)
`SolanaTransferTool`, and their own published skill documents stale names.
Without normalisation no manifest matches on a real integration and
*everything* degrades to `coverage.no_manifest`. Cheap, and blocking A1.

---

## B — Checagens que faltam

### B1 · Agregado, check D **[bloqueado]**
A hundred outflows of 499 under a ceiling of 500 pass. Check B now sums the
legs inside one transaction; across transactions there is nothing. Needs
persisted history — Postgres + Drizzle, which CLAUDE.md puts in a later phase.
*(pending T.8)*

### B2 · Envelope de tarefa, vínculo 1↔2 **[decisão]**
Nothing compares the tool the agent called against the task the user asked
for. Two halves: the comparator is deterministic and can be built now against
a hand-written envelope; the derivation needs a model call once per task.
Per spec it never blocks alone — it raises severity and narrows scope.

*Decided already:* inference runs on the customer's endpoint, schema/prompt/
clamp are ours.

### B3 · Veto Input Guard, check E **[feito — falta só o modelo por fora]**
Classify every captured chunk with Prompt Guard 2 (86M, runs on CPU in
process). It **labels, never drops** — a dropped chunk destroys the record
that explains where an address came from. Catches instruction-shaped attacks;
provenance already covers content-shaped ones. The friend's repo has a working
FastAPI implementation of exactly this, in Python.

### B4 · Re-simulação diferencial **[livre]**
*Ideia vinda do veto-lab.* Simulate the same transaction under several
perturbed contexts, fingerprint the normalised effects, and treat disagreement
as a finding. Catches a program that behaves differently depending on context.
VETO has no equivalent. The Solana version is re-simulating across slots and
diffing the `EffectSet`. Cost: multiplies RPC volume, which item D4 is already
about.

### B6 · Juiz que propõe política, nunca decide **[bloqueado]**
*Escolhido em vez de um juiz com poder de reverter o veredito.* An LLM reads
the accumulated record and proposes: a manifest for a tool that keeps hitting
`no_manifest`, an allowlist entry for an address that keeps appearing
legitimately, a trusted source, a threshold. A human approves a diff; nothing
is auto-applied; an approved proposal becomes versioned configuration and
`policyVersion` changes on its own.

Three rules make it safe:

- It reads the **structured record** — verdicts, findings, tool calls,
  effects — and never the untrusted content. A proposer that reads
  attacker-controlled prose is a slower version of the judge we rejected.
- Every proposal is **replayed against history** and shown with the past
  verdicts it would have changed. "Allowlist this address" is approved or
  refused on what it would have let through, not on whether it reads
  reasonably.
- It runs **offline**, so its latency and availability never touch a decision.

Depends on the same persisted store as B1, and shares its corpus.

### B5 · Negação em padrões de efeito **[livre]**
A swap that drains a *different* mint from the caller's own account matches
`swap`'s loose `may`, and its scope is `open`. Expressing "a decrease owned by
`arg:from` of any mint other than `arg:mint`" needs negation, which the schema
cannot say today. *(pending T.10)*

---

## G — Camadas externas: o que já está pronto para receber

Cada uma é uma URL em `.env`; ausente, um stub no-op ocupa o lugar e o
pipeline roda inteiro. O contrato de cada uma está em `src/adapters/config.ts`
e no `.env.example`.

| Camada | Variável | Recebe | Devolve | Regra que o VETO impõe |
|---|---|---|---|---|
| Juiz (Gemma) | `VETO_JUDGE_URL` | `{ record, effects, userGoal, toolCall, chunks }` | `{ tighten: null \| {to, reason}, model }` | só aperta; não simula; pulado se já DENY |
| Guard (Prompt Guard) | `VETO_GUARD_URL` | `{ text, provenance, source? }` | `{ label, score, model }` | rotula, nunca remove; rótulo sobe, nunca desce |
| OCR | `VETO_OCR_URL` | `{ image: base64, mimeType }` | `{ text, model }` | entra como trecho `via: "ocr"` com a origem da imagem |
| Corretor | `VETO_CORRECTOR_URL` | `{ text }` | `{ text, model }` | só o modelo lê a cópia; endereço/valor alterado → recusado |

Toda falha (timeout, corpo inválido, violação do contrato) vira uma linha em
`degradations` e um finding `coverage.capture_degraded` no veredito. A
"Pesquisa" do Lucas, seja o que for, entra pelo mesmo caminho: trechos com
carimbo de origem.

### G1 · Envelope de tarefa (B2) continua aberto
O corretor conserta typo; não conserta o modelo escolher a ferramenta errada
com uma prompt bem escrita. Quem pega isso é o envelope, e ele ainda não existe.

---

## C — Cobertura de manifestos

The engine is only as useful as the manifests. Nine exist; Solana Agent Kit
alone exposes 60+ tools, so today a real integration would flag almost every
call — and a customer who sees a flag on every call stops reading them.

### C1 · Manifestos para as primitivas de DeFi **[livre]**
In the order the agents' money actually is: `stake` / `stakeWithJup`,
`lendAsset`, `luloLend` / `luloWithdraw`, then perps (`openPerpTradeLong`,
`closePerpTrade*`, `driftPerpTrade`).

### C2 · Manifesto para financiar conta de token **[livre]**
Two recorded scenarios wrap SOL into an account that did not exist. No token
leaves anyone, so `transfer_token` reported a decrease that was never going to
happen. They degrade to `coverage.no_manifest` today. *(pending T.7)*

### C3 · Amounts em `number` do lado do cliente **[livre]**
Every amount in Solana Agent Kit's schemas is `number`. Above 2^53 the
declaration is not representable, while the on-chain effect is exact `u64`.
Our side is bigint; theirs is not. Needs a documented rule for what happens
when the declared amount arrives already rounded.

---

## D — Extração e normalizador

Verified against ground truth: fee 200/200 exact, account resolution agrees
with the SDK, 375/375 effects conform to the shape contract. What is left are
limits rather than defects.

### D1 · Decodificar stake e o loader atualizável **[livre]**
Today an account owned by Stake, Vote, the upgradeable loader or Config whose
bytes changed produces one blanket `coverage.undecoded_authority_account`.
Decoding them turns that into a real `AUTHORITY_CHANGE` naming the old and new
authority. *(pending 3.2)*

### D2 · Ler os valores das extensões Token-2022 **[livre]**
The TLV type ids are parsed, so `transfer_hook` is named. The values are not,
so we cannot say which program the hook calls. *(pending T.12)*

### D3 · Corrida de slot **[bloqueado]**
There is no way to read state and simulate atomically over public RPC.
Mitigated 4-in-5 by parallel calls plus alignment retry, declared through
`baselineSlot`. The remaining option costs double the RPC calls. *(pending
2.11)*

### D4 · Orçamento de chamadas e latência **[livre]**
No measurement exists. The fee no longer costs a round trip, so each alignment
attempt is two calls instead of three. The target is deciding under 100 ms and
nobody has timed it. *(pending 2.7, 2.13, T.4)*

---

## E — Medição e prova

### E1 · Suíte adversarial **[livre]**
Synthesise the attack shapes we know we miss and measure which ones VETO
catches. Turns "accuracy" from an opinion into a number, and it is the ground
truth we lack on the attack side. The honest-declaration sampler already
measures the false-positive side.

### E2 · Fixtures adversariais **[livre]**
*Ideia vinda do veto-lab.* Their Solidity fixtures name attack shapes worth
having Solana analogues of — above all a token that emits a transfer event
with no state change, which defeats any event-based extractor and is the
argument for our account-diff choice. Also: time-gated behaviour, hidden
approval, address poisoning, malicious router.

### E3 · Metodologia de medição **[livre]**
*Ideia vinda do veto-lab.* Attacks generated vs identified vs confirmed,
false-positive rate, legitimate-task completion, and the explicit rule that a
task failure is not an attack. Chain-agnostic and directly reusable.

### E4 · Cadeia de ids correlacionáveis **[livre]**
*Ideia vinda do veto-lab.* `experiment_id · run_id · trace_id · intent_id ·
incident_id`, so a whole test can be reconstructed from scenario to verdict to
on-chain result to audit. We have `actionId` and `policyVersion` and nothing
tying a session together.

### E5 · Fixtures das operações perigosas **[livre]**
`set_authority`, `freeze_account` and `burn_tokens` fail against a wallet that
owns no token account, so they never produce effects. Recording them on devnet
the way `unlimited-approve` is recorded — create the account and act on it in
one transaction — would show `ACCOUNT_FREEZE`, `OWNER_CHANGE` and a burn
producing real effects.

### E6 · Corpus de tráfego real de agente **[bloqueado]**
Roughly 80% of sampled mainnet traffic matches no primitive we cover, because
it is arbitrage and market-making rather than agents. The number that matters
is for real agent traffic, and that needs an integrator. *(pending T.11)*

---

## F — Demo e produto

### F1 · Créditos no modelo **[bloqueado]**
The agent panel is built and the key works; the account has no credits. This
is the only thing blocking the main demo path.

### F2 · Classificar a lista ao vivo **[livre]**
The live block list does not say which transactions map to a primitive we
cover, so finding one that produces a real verdict means clicking through them
one at a time. Costs a simulation per row.

### F3 · Configuração de cliente pela UI **[livre]**
Allowlist, trusted sources, known counterparties and own accounts are the
customer's declaration of what is legitimate by nature. Today they are
hardcoded empty in the demo. This is also where a mistake silently switches
off a detector, so it needs the preview that T.1 asks for.

### F4 · Persistência das rodadas **[livre]**
Everything disappears on reload. A demo that cannot show yesterday's run
cannot show a trend.

---

## G — Operação

### G1 · CI **[decisão]**
`pnpm typecheck && pnpm test` on every push. Touches repository settings.
*(pending T.5)*

### G2 · Política de timeout e retry **[livre]**
Deadlines exist — 1.5 s read, 3 s simulate, 5 s total in the normalizer.
Retry policy beyond the alignment attempts is undecided. *(pending 2.6)*

### G3 · Disponibilidade como superfície de ataque **[decisão]**
Degrade-never-open means whoever can degrade the RPC can stop all agent
activity. That is the correct trade for a security gate and it is still a
denial of service; it needs to be a documented operational choice rather than
a surprise. *(pending T.18)*

### G4 · Calibração dos números escolhidos por julgamento **[livre]**
`MAX_TOLERANCE = 0.10`, the fee ceiling of 0.01 SOL, the severity of every
coverage finding, and the two thresholds. All were chosen by reasoning and
some now have evidence. None have been fitted to data. *(pending 1.6, 1.7,
1.8, T.9)*

---

## H — Fora de escopo até alguém decidir o contrário

### H1 · Asserção on-chain
A simulation is not an execution: state moves between the verdict and
inclusion. No amount of polish fixes this — the answer is an on-chain
assertion that fails the transaction if what it depended on moved. CLAUDE.md
already names Lighthouse. *(pending T.14)*

### H2 · Quarto estado de decisão
`allow / flag / deny` assumes there is an agent. A transaction pulled off a
live block has no declaration, and the demo currently says so in words. A
fourth state would make that semantics rather than wording.

### H3 · O laboratório em EVM
The friend's repo is an Ethereum lab, not a Solana component: Anvil, ERC-20,
`debug_traceCall`. Its ideas are in B4, A3, E2, E3 and E4 above. Reusing the
code itself would mean either porting the chain layer or running two products.
Its one-click demo reads its numbers from a hardcoded table rather than from
the guard, which is worth knowing before anyone presents them.
