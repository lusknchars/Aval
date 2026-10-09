˜# VETO — A camada de avaliação

*Como a ferramenta entende o que o agente queria fazer e decide se a transação faz sentido.*

Este documento cobre apenas o componente 3. Captura, gate, painel e remediação estão fora do escopo aqui.

# 1. O problema, enunciado com precisão

De um lado você tem uma frase: *"faça swap de 10 USDC por SOL"*.

Do outro, um diff de estado: `−10 USDC`, `+0,048 SOL`, `delegate ilimitado concedido a 7xKX…9fPq`.

Essas duas coisas não são comparáveis. Uma é linguagem natural, ambígua e infinita. A outra é um conjunto finito de mudanças de estado. Comparar diretamente exigiria interpretação semântica, que é fuzzy, cara e cheia de falso positivo.

**A camada de avaliação existe para resolver isso.** E a saída não é "traduzir o diff para linguagem" nem "pedir para um modelo julgar". É reduzir os dois lados a um vocabulário comum, fechado e pequeno.

# 2. A descoberta que simplifica tudo: não são dois níveis, são três

Este é o ponto que dissolve a maior parte da confusão.

Entre a frase e o diff existe um terceiro objeto, e ele já é estruturado:

```
  NÍVEL 1 — Objetivo do usuário        linguagem natural, ambíguo
  "faça swap de 10 USDC por SOL"
              │
              ▼
  NÍVEL 2 — Tool call                  ESTRUTURADO
  swap({ from: "USDC", to: "SOL", amount: 10 })
              │
              ▼
  NÍVEL 3 — Efeito simulado            ESTRUTURADO
  { balanceDeltas: [...], delegatesGranted: [...] }
```

**O agente já fez a tradução de linguagem para estrutura por você.** Ele não apenas disse algo — ele emitiu uma chamada de função com argumentos nomeados. Esse é o pivô.

Consequência prática: a comparação entre os níveis 2 e 3 **não precisa de semântica nenhuma**. Os dois lados já são precisos. É comparação de conjuntos, não interpretação.

Só o vínculo entre 1 e 2 é fuzzy — e ele é tratado de forma separada, com uma técnica diferente, na seção 6.

# 3. Três lacunas, três mecanismos

Cada vínculo falha de um jeito diferente, e cada um exige uma verificação própria. Confundir isso é o erro mais caro do projeto.

| Lacuna | Pergunta | Mecanismo | O que pega |
|---|---|---|---|
| 2 ↔ 3 | A transação faz o que o tool call diz? | Manifesto + diff | Efeito a mais, magnitude errada |
| origem dos args | De onde vieram os argumentos? | Proveniência | Injection que corrompe o destino |
| 1 ↔ 2 | A ferramenta chamada é o que foi pedido? | Envelope de tarefa | Ação inteiramente fora do escopo |

## Por que as três são necessárias

Considere o ataque mais comum de prompt injection: o agente lê uma página envenenada e emite `transfer({ to: "7xKX…", amount: 500 })`.

Agora repare: **a verificação 2↔3 passa perfeitamente.** O tool call diz transferir 500 para `7xKX…`, e a transação transfere exatamente 500 para `7xKX…`. Zero divergência. O agente executou fielmente o que ele próprio decidiu.

A corrupção não está na execução. Está na **origem do argumento**.

É por isso que a proveniência é o detector mais valioso do sistema — é o único que enxerga esse caso, que é justamente o mais frequente.

E é por isso que ninguém mais pega esse ataque: teto de gasto vê um valor plausível, allowlist só ajuda se o endereço já estivesse na lista, e a verificação de coerência entre tool call e transação não vê nada de errado.

# 4. O vocabulário comum

O núcleo da padronização. Um conjunto **fechado e pequeno** de tipos de efeito. Tudo que uma transação faz é expresso neles, e tudo que um manifesto espera é expresso nos mesmos.

```ts
type EffectType =
  | 'BALANCE_DECREASE'    // conta perdeu valor
  | 'BALANCE_INCREASE'    // conta ganhou valor
  | 'DELEGATE_GRANT'      // autoridade de gasto concedida a terceiro
  | 'AUTHORITY_CHANGE'    // mint / freeze / upgrade / close authority alterada
  | 'OWNER_CHANGE'        // dono da conta alterado
  | 'ACCOUNT_CREATE'
  | 'ACCOUNT_CLOSE'
  | 'PROGRAM_INVOKE'      // programa chamado, inclusive via CPI

interface Effect {
  type: EffectType
  account: string
  mint?: string
  amount?: bigint
  counterparty?: string    // quem recebe valor ou autoridade
  program?: string
}
```

Oito tipos. É pouco de propósito.

**Por que fechado importa:** com um vocabulário fechado, "o que a transação fez" e "o que a ferramenta deveria fazer" viram dois conjuntos do mesmo tipo. A comparação é operação de conjunto — diferença, interseção, pertencimento. Não há espaço para interpretação, e portanto não há falso positivo vindo de ambiguidade.

**Por que pequeno importa:** oito tipos cobrem praticamente todo dano possível em Solana. Perder valor, ceder autoridade, perder a conta. O resto é detalhe de implementação de programa, que não interessa para detecção de dano.

**Por que é agnóstico a programa:** os tipos são derivados do modelo de contas, não de instruções. Um programa que você nunca viu, se ele conceder um delegate, produz `DELEGATE_GRANT` do mesmo jeito. O layout da conta de token SPL é fixo — `amount`, `owner` e `delegate` saem dos bytes em offsets conhecidos, sem IDL nenhum.

# 5. O manifesto de ferramenta

O tradutor do lado esquerdo. Declara, no mesmo vocabulário, o que cada ferramenta legitimamente causa.

## Estrutura

```ts
interface ToolManifest {
  tool: string

  must: EffectPattern[]      // tem que acontecer
  may:  EffectPattern[]      // pode acontecer, não é obrigatório
  mustNot: EffectType[]      // presença = violação imediata

  accountScope: 'args_only' | 'args_plus_derived' | 'open'
  programAllowlist?: string[]
}

interface EffectPattern {
  type: EffectType
  account?: ArgRef | string     // "arg:from" resolve no argumento do tool call
  mint?: ArgRef | string
  maxAmount?: ArgRef | bigint
  tolerance?: number            // fração, para slippage e taxa
}

type ArgRef = `arg:${string}`
```

## Como os placeholders resolvem

`arg:from` não é uma string literal — é uma referência que é resolvida contra os argumentos daquele tool call específico, no momento da avaliação.

```
manifesto diz:   BALANCE_DECREASE em arg:from, máximo arg:amount
tool call foi:   swap({ from: "ATokenAcc…", to: "…", amount: 10 })
resolve para:    BALANCE_DECREASE em "ATokenAcc…", máximo 10
```

Só depois disso a comparação com o `EffectSet` acontece. É por isso que um manifesto escrito uma vez serve para infinitas chamadas.

## Exemplos escritos

**Transferência**

```
transfer(from, to, mint, amount)

  must     BALANCE_DECREASE  conta=arg:from  mint=arg:mint  max=arg:amount
           BALANCE_INCREASE  conta=arg:to    mint=arg:mint

  may      ACCOUNT_CREATE                  (conta de token do destinatário)
           BALANCE_DECREASE  mint=SOL      (rent + fee)

  mustNot  DELEGATE_GRANT
           AUTHORITY_CHANGE
           OWNER_CHANGE
           ACCOUNT_CLOSE

  escopo   args_plus_derived
```

**Swap**

```
swap(from, to, amountIn, minAmountOut)

  must     BALANCE_DECREASE  conta=arg:from  max=arg:amountIn
           BALANCE_INCREASE  conta=arg:to    min=arg:minAmountOut

  may      PROGRAM_INVOKE    programa ∈ allowlist de DEXs
           ACCOUNT_CREATE
           BALANCE_DECREASE  mint=SOL

  mustNot  DELEGATE_GRANT
           AUTHORITY_CHANGE
           OWNER_CHANGE

  escopo   args_plus_derived
  tolerância  0.03
```

**Aprovação** — o caso instrutivo

```
approve(account, delegate, amount)

  must     DELEGATE_GRANT  conta=arg:account  para=arg:delegate  max=arg:amount

  mustNot  BALANCE_DECREASE
           AUTHORITY_CHANGE

  escopo   args_only
```

Repare: `DELEGATE_GRANT` é proibido em transfer e swap, e obrigatório em approve. **O mesmo efeito é crítico num contexto e esperado noutro.** É exatamente essa diferença que nenhuma política estática consegue expressar — ela só sabe dizer "delegate permitido" ou "delegate proibido", globalmente.

Mesmo aqui, a proveniência continua valendo: um `approve` legítimo com o `delegate` vindo de uma página web continua sendo crítico.

## Escopo de contas

| Valor | Significado |
|---|---|
| `args_only` | Só as contas citadas nos argumentos podem ser tocadas |
| `args_plus_derived` | Também PDAs derivados delas e contas de token associadas |
| `open` | Sem restrição — usar apenas quando inevitável |

Conta tocada fora do escopo é achado de severidade alta.

## Quando não existe manifesto

Nem toda ferramenta terá um. O sistema **degrada, não libera**:

| Verificação | Funciona sem manifesto? |
|---|---|
| Efeito não declarado | Não |
| Magnitude | Não |
| **Proveniência** | **Sim** |
| **Agregado** | **Sim** |
| **Efeitos sempre-críticos** | **Sim** |

Efeitos sempre-críticos são um conjunto mínimo que nunca é aceitável sem manifesto explícito que os autorize: `AUTHORITY_CHANGE`, `OWNER_CHANGE` e `DELEGATE_GRANT` com allowance ilimitada.

## Custo real

Ações de agente se concentram em poucas primitivas: transferir, swap, aprovar, revogar, stakar, deslocar stake, mintar, queimar, fechar conta, depositar e sacar de protocolo. **Cerca de vinte manifestos cobrem a maior parte do que acontece na prática**, e eles são reaproveitados entre todos os clientes.

# 6. O envelope de tarefa — onde a linguagem natural é tratada

O vínculo 1↔2 é o único que realmente exige interpretação. A técnica aqui é diferente, e a ideia central é: **interpretar uma vez por tarefa, não uma vez por transação.**

## Como funciona

Quando o usuário enuncia um objetivo, um modelo converte aquela frase, **uma única vez**, num objeto estruturado:

```ts
interface TaskEnvelope {
  taskId: string
  goalText: string

  allowedTools: string[]           // ferramentas coerentes com o pedido
  valueCeiling?: { mint: string; max: bigint }
  namedCounterparties: string[]    // endereços e entidades citados no objetivo
  expiresAt: number

  derivedBy: string                // modelo e versão, para auditoria
  derivedAt: number
}
```

A partir daí, **toda ação subsequente é verificada contra o envelope de forma determinística**. Ferramenta fora de `allowedTools` é achado. Valor acima do teto é achado. Ação depois de `expiresAt` é achado.

## Por que isso resolve os dois problemas do LLM

**Latência.** Um objetivo de usuário gera dezenas ou centenas de ações. A chamada de modelo acontece uma vez, no início, fora do loop. Cada ação individual é avaliada por comparação de campos, em microssegundos.

**Auditabilidade.** O envelope é um artefato persistido, com modelo e timestamp registrados. Meses depois é possível mostrar exatamente qual escopo estava em vigor e de onde ele veio. "O modelo decidiu no momento" não é auditável; "este era o envelope derivado, aqui está" é.

## Limites honestos

O envelope é a parte mais fraca da camada de avaliação, e vale saber por quê.

Objetivos vagos produzem envelopes largos. *"Gerencie meu portfólio"* não restringe quase nada. Nesses casos o envelope contribui pouco e o peso recai sobre o manifesto e a proveniência.

Objetivos de longa duração envelhecem. Um agente que roda por semanas precisa de renovação periódica do envelope.

**Por isso o envelope nunca é a única verificação, e nunca sozinho gera um bloqueio.** Ele eleva severidade e restringe escopo; quem bloqueia são os mecanismos determinísticos.

# 7. Proveniência — o detector central

Responde a pergunta que os outros não fazem: **de onde veio este endereço?**

## Classificação

Para cada `counterparty` do `EffectSet`:

| Origem | Veredito | Severidade |
|---|---|---|
| Citado no objetivo do usuário | legítimo | — |
| Na allowlist configurada | legítimo | — |
| Saída de ferramenta de fonte confiável | provável | baixa |
| Histórico: já interagiu antes com este agente | atenção | média |
| Apenas em chunk `retrieved` / `memory` / `tool_output` não confiável | **suspeito** | **crítica** |
| Não aparece em lugar nenhum do contexto | **inexplicado** | **crítica** |

## Implementação

Busca da string base58 nos `contextChunks`, classificando pela `provenance` do chunk onde a ocorrência aparece.

Cuidados que importam:

**Correspondência parcial.** Um endereço pode aparecer truncado (`7xKX…9fPq`) ou fatiado entre linhas. Casar prefixo e sufixo, não só a string inteira.

**Ofuscação.** Endereço montado por concatenação no contexto, ou codificado. Não há solução completa; registrar como limitação conhecida.

**Ausência total é sinal, não silêncio.** Um endereço que não aparece em nenhum chunk é mais suspeito, não menos. Foi produzido em algum lugar que o VETO não observa.

## A maior fonte de falso positivo, e como tratar

Nem todo conteúdo recuperado é hostil.

Um agente que consulta a API do Jupiter recebe endereços de rota legítimos que não estavam no objetivo do usuário. Se todo `tool_output` for tratado como não confiável, o sistema alerta o tempo todo e o cliente desliga.

A solução é **nível de confiança por fonte**, configurado pelo cliente:

```ts
interface SourceTrust {
  pattern: string                  // domínio, nome da ferramenta, chave de memória
  level: 'trusted' | 'semi' | 'untrusted'
}
```

Endereço vindo de fonte `trusted` é tratado como provável. De `untrusted`, crítico. O padrão para qualquer fonte não configurada é `untrusted`.

Configurar as fontes confiáveis passa a ser parte do onboarding do cliente — e é justamente o tipo de configuração que o cliente quer fazer, porque ela reflete a arquitetura real do agente dele.

# 8. Agregado

Única verificação que exige estado persistido, e a única que enxerga sequência.

- Valor movimentado por janela deslizante, global
- Valor movimentado por contraparte
- Contagem de ações por janela
- Fração do saldo total movimentada
- Contagem de achados de severidade média na janela — muitos "atenção" juntos viram um "crítico"

Pega o que política estática não pega por construção: cem transações de 499 sob um teto de 500.

# 9. Como os achados viram veredito

**Não usar soma ponderada de scores.** Score numérico é impossível de explicar a um auditor e impossível de calibrar com confiança.

A regra é teto de severidade:

```
qualquer achado crítico                     → DENY
dois ou mais achados altos                  → DENY
um achado alto                              → FLAG
apenas achados médios ou baixos             → FLAG se acima do limiar, senão ALLOW
nenhum achado                               → ALLOW
```

Todos os limiares são configuráveis por cliente, e a versão da política fica registrada em cada veredito.

Vantagem: qualquer decisão é rastreável até um achado nomeado e uma regra específica. Nunca a uma ponderação opaca.

# 10. Exemplo completo

**Objetivo do usuário**
*"reequilibre meu portfólio, converta parte do USDC em SOL"*

**Envelope derivado (uma vez)**
```
allowedTools: [swap, transfer_internal]
valueCeiling: 2000 USDC
namedCounterparties: []
expiresAt: +2h
```

**O agente consulta uma página de análise de mercado.** A página contém texto injetado instruindo a aprovar um contrato de "otimização de rendimento".

**Tool call emitido**
```
swap({ from: "ATokenAcc…", to: "SolAcc…", amountIn: 400, minAmountOut: 1.9 })
```

**Efeito simulado**
```
BALANCE_DECREASE  ATokenAcc…   USDC   400
BALANCE_INCREASE  SolAcc…      SOL    1.94
PROGRAM_INVOKE    JUP6Lkb…
DELEGATE_GRANT    ATokenAcc…   →  7xKX…9fPq   amount = u64::MAX
```

**Avaliação**

| Verificação | Resultado |
|---|---|
| Envelope (1↔2) | `swap` está em `allowedTools`, 400 < 2000 → ok |
| Manifesto — must | Decremento e incremento presentes, dentro da tolerância → ok |
| Manifesto — may | Jupiter está na allowlist → ok |
| **Manifesto — mustNot** | **`DELEGATE_GRANT` presente. CRÍTICO** |
| **Proveniência** | **`7xKX…9fPq` aparece só em chunk `retrieved`, fonte não confiável. CRÍTICO** |
| Agregado | Dentro dos limites → ok |

**Veredito:** `DENY` — dois achados críticos.

**Explicação exibida** *(gerada por LLM, depois da decisão, fora do caminho crítico)*

> Bloqueado. O swap em si está correto, mas a transação também concede permissão ilimitada de gasto sobre sua conta de USDC a um endereço que apareceu apenas na página de análise que o agente consultou — não no seu pedido.

Repare que a explicação nomeia exatamente o que estava errado e por quê. É essa frase que faz o cliente confiar no produto.

# 11. Fontes conhecidas de falso positivo

Lista honesta. Cada item precisa de tratamento explícito.

| Fonte | Tratamento |
|---|---|
| Endereço legítimo vindo de API de roteamento | Nível de confiança por fonte |
| Slippage alto em mercado volátil | Tolerância por ferramenta, com severidade própria |
| Contas intermediárias criadas por programa | Escopo `args_plus_derived` |
| Objetivo vago gerando envelope largo | Envelope não bloqueia sozinho |
| Agente legitimamente mudando de comportamento após deploy | Correlacionar com evento de deploy *(fase 2)* |
| Ferramenta nova sem manifesto | Degradação para verificações independentes |

**Falso positivo é o risco número um do produto.** Cliente que desliga o alerta na segunda semana é cliente perdido. É por isso que o modo observação é obrigatório no início e por que a ancoragem determinística importa mais que sofisticação.

# 12. O que não está nesta camada

**Modelo de anomalia comportamental.** Fase 2, exige semanas de dados acumulados. Quando entrar: modelo pontua, regra decide.

**Detecção de envenenamento de memória.** Opera sobre o que o agente escreve, não sobre transação. Camada separada.

**Aplicação e remediação.** O `Verdict` é a fronteira desta camada. O que fazer com ele é o componente 4.

# 13. Ordem de implementação

| # | Peça | Testável isoladamente? |
|---|---|---|
| 1 | Vocabulário de efeitos + extração do diff | Sim — transações gravadas |
| 2 | Proveniência | Sim — contexto sintético |
| 3 | Resolvedor de manifesto + verificações must/mustNot | Sim |
| 4 | Magnitude e tolerância | Sim |
| 5 | Agregado + persistência | Precisa de série temporal |
| 6 | Envelope de tarefa | Precisa de LLM |
| 7 | Combinação de achados em veredito | Sim |
| 8 | Explicação por LLM | Sim |

Peças 1 a 3 já detectam o cenário de injection do exemplo da seção 10 — e são as três mais fáceis.
