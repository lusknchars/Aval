# VETO

Camada de detecção comportamental para agentes de IA autônomos que
operam carteiras em Solana. Detecta divergência entre o que o agente
declarou que ia fazer e o que a transação de fato faz.

Analogia: Turnkey/Privy/DCP são o firewall (política estática).
VETO é o EDR (detecção comportamental).

## Stack

TypeScript estrito. Node 20+. pnpm.
`@solana/web3.js`, `@solana/spl-token`, `bs58`, `zod`, `vitest`.
RPC: Helius. Postgres + Drizzle para persistência (fase posterior).

## Decisões de arquitetura — não reverter sem me perguntar

- **Sem Rust no caminho crítico.** Tudo TypeScript.
- **Nível de diff de conta, não decodificação de instrução.** O layout
  da conta SPL é fixo; ler `amount`/`owner`/`delegate` dos bytes. Não
  construir decodificador universal por IDL. Anchor IDL só como
  enriquecimento opcional da mensagem de alerta.
- **Decisão determinística.** Nenhum LLM no caminho de decisão. LLM
  só para explicar alerta (depois da decisão) e derivar envelope de
  tarefa (uma vez por tarefa).
- **Nunca julgar veracidade de conteúdo.** Só rastrear origem.
- **Usar Lighthouse** para asserção on-chain, não escrever programa.
- **Degradar, não liberar.** Falta de informação nunca vira ALLOW.

## Vocabulário de efeitos — fechado, 8 tipos

BALANCE_DECREASE, BALANCE_INCREASE, DELEGATE_GRANT,
AUTHORITY_CHANGE, OWNER_CHANGE, ACCOUNT_CREATE, ACCOUNT_CLOSE,
PROGRAM_INVOKE

Não adicionar tipos sem me perguntar.

## Estrutura

```
src/
  captura/        # wrapper do agente, marcação de proveniência
  normalizacao/   # tx -> EffectSet (simulação + diff)
  avaliacao/      # manifestos, proveniência, agregado -> Verdict
  gate/           # allow / flag / deny
  tipos/          # interfaces compartilhadas
test/
  fixtures/       # transações gravadas para teste isolado
```


## Convenções

- Nomes de domínio em português (`proveniencia`, `veredito`,
  `manifesto`); termos técnicos de Solana em inglês (`delegate`,
  `authority`, `mint`).
- Sem `any`. Sem `as` fora de decodificação de buffer.
- `bigint` para qualquer valor de token. Nunca `number`.
- Toda função pura testável sem rede. Chamadas de RPC isoladas em
  módulo próprio.
- Erro nunca engolido. Falha de simulação é um resultado, não uma
  exceção silenciosa.

## Como trabalhar comigo

- **Explique antes de escrever.** Diga o que vai fazer e por quê,
  depois escreva.
- **Pedaços pequenos.** Um módulo por vez, com o caminho do arquivo
  explícito. Não gere cinco arquivos de uma vez.
- **Teste junto.** Toda peça nova vem com teste usando fixture, não
  com chamada de rede.
- **Pergunte quando a spec estiver ambígua** em vez de escolher por
  mim.
- Português do Brasil.

## Prioridade atual

Etapa 3 — o normalizador. `simulateTransaction` com `accounts` e
`innerInstructions`, diff do estado antes/depois, saída no
`EffectSet`. Testável isolado com transações reais gravadas da
mainnet.

Etapas seguintes: proveniência, manifestos, gate.

## Contexto adicional

Documentos de especificação em `/docs`:
- `veto-status.md` — definido e em aberto
- `veto-construcao.md` — arquitetura geral
- `veto-camada-avaliacao.md` — detalhe do motor de avaliação