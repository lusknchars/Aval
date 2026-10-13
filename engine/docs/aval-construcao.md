# AVAL — Documento de construção

*Especificação técnica do POC. Como a ferramenta funciona por dentro e em que ordem construir.*

# Princípio de projeto

Três regras que valem para todo o resto do documento.

**Nunca comparar texto livre com texto livre.** Os dois lados da comparação são reduzidos a um vocabulário estruturado antes de se encontrarem. É isso que separa o AVAL da literatura acadêmica de detecção de injection, que compara strings por similaridade semântica e sofre de falso positivo por construção.

**A decisão é determinística.** Modelo de linguagem explica e desempata, nunca decide. Motivo duplo: latência no loop do agente, e auditabilidade perante um auditor de compliance.

**Degradar, não liberar.** Quando falta informação, o sistema cai para as verificações que ainda funcionam. Ausência de dado nunca vira aprovação automática.

# Arquitetura

```
                        ┌──────────────┐
  agente ──────────────▶│  1. captura  │
                        └──────┬───────┘
                               │ tx não assinada + contexto
                        ┌──────▼─────────────┐
                        │  2. normalização   │──▶ simulateTransaction (RPC)
                        └──────┬─────────────┘
                               │ EffectSet
                        ┌──────▼─────────────┐
                        │  3. avaliação      │◀── manifestos + estado histórico
                        └──────┬─────────────┘
                               │ Verdict
                        ┌──────▼─────────────┐        ┌────────────┐
                        │  4. gate           │───────▶│ 5. painel  │
                        └──────┬─────────────┘        └────────────┘
                               │ assina / recusa
                            chain
```

Stack: TypeScript em tudo. Sem Rust no caminho crítico.

# Componente 1 — Captura

Biblioteca que envolve o agente e produz um registro por ação.

```ts
interface ActionContext {
  actionId: string
  agentId: string

  userGoal: string              // o que o humano pediu
  systemPrompt: string

  contextChunks: ContextChunk[] // tudo que entrou no contexto do modelo
  toolCall: { name: string; args: Record<string, unknown> }

  unsignedTx: VersionedTransaction
  timestamp: number
}

interface ContextChunk {
  text: string
  provenance: 'user' | 'system' | 'retrieved' | 'memory' | 'tool_output'
  source?: string               // url, id do documento, chave da memória
}
```

**O campo `provenance` é o mais importante de todo o sistema.** Sem ele, o detector mais valioso do AVAL não existe.

É também o ponto de maior risco de integração: se o framework do agente não separa contexto confiável de conteúdo recuperado, essa separação precisa ser forçada na camada de RAG e memória. Investigar antes de escolher qual framework instrumentar.

# Componente 2 — Normalização

Converte a transação num efeito estruturado, antes de assinar.

**Procedimento**

1. `simulateTransaction` com retorno das contas envolvidas e das inner instructions
2. Ler o estado das mesmas contas antes da simulação
3. Fazer o diff

**Por que funciona sem decodificador de instruções**

O layout da conta de token SPL é fixo e conhecido. `amount`, `owner` e `delegate` são lidos direto dos bytes, em offsets fixos, sem IDL de programa nenhum.

Isso significa que a normalização funciona contra programas que o AVAL nunca viu. É o corte de escopo que torna o projeto viável — decodificar instrução por instrução exigiria o IDL de cada programa do ecossistema e nunca terminaria.

Decodificação por IDL fica como enriquecimento opcional, só para melhorar a mensagem do alerta.

**Saída**

```ts
interface EffectSet {
  balanceDeltas: { account: string; mint: string | 'SOL'; delta: bigint }[]
  ownerChanges:  { account: string; from: string; to: string }[]
  authorityChanges: {
    account: string
    kind: 'mint' | 'freeze' | 'upgrade' | 'close'
    from: string | null
    to: string | null
  }[]
  delegatesGranted: { account: string; delegate: string; amount: bigint }[]
  accountsCreated: string[]
  accountsClosed:  string[]
  programsInvoked: string[]      // incluindo inner instructions
  counterparties:  string[]      // quem recebe valor ou autoridade
}
```

`delegatesGranted` com `amount` igual a `u64::MAX` é allowance ilimitada — um dos sinais mais fortes do sistema.

# Componente 3 — Avaliação

## Manifestos de ferramenta

Cada ferramenta do agente ganha uma declaração escrita à mão do que ela legitimamente causa. Feito uma vez, versionado junto do código.

```ts
interface ToolManifest {
  tool: string
  expects: {
    balanceDecrease?: { account: 'arg:from'; mint: 'arg:mint'; max: 'arg:amount' }
    balanceIncrease?: { account: 'arg:to' }
    programsAllowed?: string[]
  }
  forbids: {
    delegateGrant?: boolean
    authorityChange?: boolean
    accountClose?: boolean
    untouchedAccounts?: boolean   // não pode tocar contas fora das dos argumentos
  }
}
```

Exemplo, para uma ferramenta de swap:

```
swap(from, to, amount)
  deve      → saldo[from] diminui, no máximo `amount`
              saldo[to] aumenta
  permitido → programas na lista de DEXs conhecidas
  proibido  → conceder delegate
              alterar qualquer authority
              tocar contas fora das envolvidas
```

**Escala:** ações de agente se concentram em poucas primitivas — transferir, swap, aprovar, stakar, mintar, fechar conta. Cerca de vinte manifestos cobrem a maior parte do que acontece na prática.

## Verificação A — Efeito não declarado

Percorre o `EffectSet` e marca tudo que o manifesto não prevê.

Um delegate concedido durante um swap não tem interpretação possível: não está ali porque foi pedido. É o sinal mais forte e mais limpo do sistema, sem ambiguidade nenhuma.

**Severidade:** crítica para delegate e mudança de authority; alta para conta fechada; média para programa fora da lista.

## Verificação B — Magnitude

O tool call declarou 10 USDC; o efeito mostra 500.

Tolerância configurável por ferramenta, para acomodar slippage e taxa. Slippage extremo é sinal por si só e merece severidade própria.

## Verificação C — Proveniência de contraparte

Para cada endereço em `counterparties`, determinar a origem:

| Origem | Veredito |
|---|---|
| Presente em `userGoal` | ok |
| Presente na allowlist configurada | ok |
| Já interagiu antes com este agente | atenção |
| Presente apenas em chunk `retrieved`, `memory` ou `tool_output` | **crítico** |
| Não aparece em lugar nenhum | **crítico** |

Implementação: busca da string base58 nos `contextChunks`, classificando pela `provenance` do chunk onde aparece.

**É o detector mais valioso do sistema e o mais barato de construir.** Algumas dezenas de linhas, determinístico, e quando dispara praticamente não tem falso positivo. É a impressão digital de prompt injection indireta.

## Verificação D — Agregado

Única verificação que exige estado persistido.

- Soma movimentada por janela deslizante, global
- Soma por contraparte
- Contagem de ações por janela
- Fração do saldo total movimentada

Pega o que a política estática não pega por construção: cem transações de 499 sob um teto de 500.

## Saída

```ts
interface Verdict {
  actionId: string
  decision: 'allow' | 'flag' | 'deny'
  findings: Finding[]
  evaluatedAt: number
  policyVersion: string
}

interface Finding {
  check: 'undeclared' | 'magnitude' | 'provenance' | 'aggregate'
  severity: 'low' | 'medium' | 'high' | 'critical'
  detail: Record<string, unknown>   // estruturado, não texto livre
  explanation?: string              // gerado por LLM, apenas para exibição
}
```

`policyVersion` existe para responder, meses depois, qual regra estava em vigor no momento do incidente.

# Onde o modelo de linguagem entra

Dois lugares, nenhum deles a decisão.

**Explicação do alerta.** Converte `findings` estruturados em frase legível: *"bloqueado porque a transação concede allowance ilimitada a um endereço que apareceu apenas na página consultada pelo agente"*. Roda depois da decisão, fora do caminho crítico.

**Desempate opcional.** Só para casos que as regras marcaram como ambíguos. Nunca reverte um `deny` determinístico.

# Componente 4 — Gate

Converte `Verdict` em ação, conforme o nível de operação contratado.

| Nível | Requisito no cliente | Comportamento |
|---|---|---|
| 0 · Monitoramento | Nenhum | Observa endereços via RPC. Só alerta. |
| 1 · Gate no SDK | Biblioteca local, qualquer carteira | Recusa assinar |
| 2 · Co-assinatura | Chave separada do agente | Não aprova |

**Nível 2 — caminho neutro:** Squads, por ser programa nativo e não fornecedor contratado. A chave existente do cliente vira membro, o AVAL vira o segundo, threshold 2.

**Atalhos para quem já usa:** na Turnkey, o AVAL é um service user exigido pelo campo `consensus` da política. Na Privy, é membro de quórum de chave. Nos dois casos o AVAL não detém chave — só tem voto, e portanto só consegue recusar.

**Limite físico assumido:** agente com keypair cru na própria máquina não pode ser bloqueado por serviço externo. Wrapper de SDK é controle contra raciocínio corrompido, não contra host comprometido.

## Política de degradação

Decisão obrigatória antes de qualquer cliente real: o que acontece se o AVAL ficar indisponível — bloqueia tudo ou libera tudo?

Recomendação: configurável por cliente, com padrão em *fail-open* acompanhado de alerta ruidoso. Fail-closed transforma uma queda do AVAL em parada da operação do cliente, o que é uma forma de negação de serviço causada pela própria defesa.

# Componente 5 — Painel

Uma tela importa mais que todas as outras: **a de alerta**.

Lado a lado:

```
  INTENÇÃO                          EFEITO SIMULADO
  ────────                          ───────────────
  "swap de 10 USDC por SOL"         −10 USDC
  tool: swap                        +0,048 SOL
  args: {from, to, amount: 10}      ⚠ delegate ilimitado → 7xKX…9fPq

  ORIGEM DE 7xKX…9fPq
  ───────────────────
  ✗ ausente do objetivo do usuário
  ✓ presente em chunk `retrieved` — fonte: https://…
```

É a tela que vende o produto e é a que convence na demo.

# Remediação

Transação confirmada não tem rollback. A remediação contém o que resta.

| Ação | Como | Dificuldade |
|---|---|---|
| Revogar delegate | Instrução `revoke` do SPL Token | Baixa |
| Revogar session key | API do provedor de carteira | Baixa |
| Matar o agente | Webhook / kill switch | Baixa |
| Remover do multisig | Transação de governança no Squads | Média |
| Varrer fundos | Opcional, destino pré-autorizado e imutável | Média |

A varredura exige autoridade de movimentação, o que tensiona o argumento de *"só consigo recusar"*. Por isso o destino é fixado pelo cliente antecipadamente e não pode ser alterado pelo AVAL.

# Ordem de construção

Cada etapa é demonstrável sozinha.

| # | Etapa | Observação |
|---|---|---|
| 1 | Agente vulnerável | Devnet, swap e transfer, fonte de contexto controlada. Serve de alvo e de artefato de pesquisa. |
| 2 | Captura | Só registrar, sem julgar |
| 3 | **Normalização** | Coração técnico. Testável isoladamente com transações gravadas. |
| 4 | Proveniência | Maior valor, menor custo |
| 5 | Gate no SDK | A partir daqui já existe demo completa |
| 6 | Manifestos + verificações A e B | |
| 7 | Agregado + persistência | |
| 8 | Painel | |
| 9 | Remediação | |
| 10 | Lighthouse | Asserção on-chain. Última porque pode falhar por motivo externo. |

Etapas 1 a 5 são um POC defensável. As demais transformam em produto.

# Fora do POC

**Baseline comportamental (UEBA).** Exige semanas de dados. Quando entrar: modelo pontua, regra decide. Baseline precisa ser adaptativo e correlacionado com eventos de deploy — mudança de comportamento junto com deploy é evolução, sem deploy é suspeita.

**Envenenamento de memória.** Diff do que o agente persiste na própria memória, procurando conteúdo com forma de instrução.

**Programa Anchor de registro.** Grava hash da avaliação, veredito e versão da política on-chain. Log à prova de adulteração, sem autoridade sobre valor. É o único uso de Rust aprovado.

# Riscos de engenharia

**Proveniência de contexto.** Se o framework não expõe a origem, é preciso remendar a camada de RAG e memória. Maior risco de atraso do projeto.

**Orçamento de latência.** Regras determinísticas abaixo de 100 ms decidem a maioria dos casos; LLM só no que já foi sinalizado. Desenhar assim desde o início — refazer depois é caro.

**Falso positivo.** Comportamento de agente é legitimamente estranho. Cliente que desliga o alerta na segunda semana é a morte do produto. Daí o modo observação obrigatório no início e a ancoragem no diff determinístico.

# A confirmar

- Restrição do Lighthouse: funciona com `signTransaction`, não com `signAndSendTransaction` — verificar na documentação antes de desenhar a etapa 10
- `simulateTransaction` retornando estado de conta e inner instructions conforme esperado
- Qual framework de agente expõe a origem do contexto recuperado *(bloqueia a etapa 1)*
