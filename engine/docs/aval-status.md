# VETO — Status do projeto

*Documento de controle. O que está fechado, o que está aberto.*

# PARTE 1 — DEFINIDO

## Identidade

| | |
|---|---|
| Nome | VETO |
| Categoria | Detecção comportamental para agentes autônomos on-chain |
| Chain | Solana |
| Frase de posicionamento | *Existe firewall para agente on-chain. Não existe EDR.* |
| Cor | Âmbar sobre quase-preto. Marca ≠ cor de estado. Painel majoritariamente cinza. |

## Problema

Divergência entre o que o agente declarou que ia fazer e o que a transação de fato faz.

**Escopo de ameaça é aberto por decisão.** Prompt injection, envenenamento de memória e comprometimento são exemplos, não a definição. Entram também alucinação, uso errado de ferramenta, raciocínio falho, drift de modelo, erro de configuração e dado corrompido a montante.

Motivo da abertura: erro próprio do agente é muito mais frequente que ataque. Mercado maior, venda mais fácil, e volume de dados desde o primeiro cliente.

## Evidência

| Incidente | Data | Perda |
|---|---|---|
| Step Finance | jan/2026 | 261k SOL · US$ 27–30M · empresa fechou |
| OpenClaw / Lobstar Wilde | fev/2026 | ~US$ 250k |
| Freysa | — | ~US$ 47k |

Padrão comum: **nenhuma política foi violada.** A ação estava autorizada. O que mudou foi quem pedia.

## Estrutura do mercado

| Camada | O que resolve | Quem ocupa |
|---|---|---|
| Chave | Onde a chave mora, quem assina | Turnkey, Privy, Fireblocks, Crossmint, Squads |
| Política | O que é permitido | DCP, Sol CLI, engines da Turnkey e Privy |
| **Coerência** | **Se faz sentido dado o pedido e o histórico** | **Vazio — VETO** |

Duas falhas estruturais da camada de política: não conhece a intenção, e avalia transação isolada quando o ataque é sequência (cem transações de 499 com teto de 500 passam todas).

## Sacada técnica

A literatura de detecção de injection compara texto com texto por similaridade semântica, e sofre de falso positivo por isso.

On-chain, compara-se texto com **diff de estado determinístico**. Ou o delegate ilimitado está na transação ou não está.

> O resto do mundo compara intenção com intenção. On-chain dá para comparar intenção com consequência.

## Por que Solana

- Simulação determinística, barata, com latência que cabe no loop do agente
- Densidade de transações viabiliza o modelo econômico
- É onde os incidentes de referência aconteceram
- Lighthouse existe e está em produção

## Detectores

| Detector | MVP |
|---|---|
| Proveniência de contexto — destino apareceu em conteúdo recuperado, não no objetivo | **Sim — carro-chefe** |
| Divergência intenção × efeito, por regra | Sim |
| Teto agregado em janela de tempo | Sim |
| Divergência por julgamento de LLM | Segunda camada |
| Baseline comportamental (UEBA) | Não — exige dados |
| Envenenamento de memória | Não |

O detector de maior valor é o de menor complexidade.

## Cortes de escopo

**Não construir decodificador de instruções.** Trabalhar em nível de diff de conta — saldo, owner, authority, delegate. Agnóstico a programa.

**Não escrever programa de custódia.** Lighthouse já faz asserção de pós-estado, está em produção na Phantom e é usado pelo Kora. POC inteiro em TypeScript.

## Modelo de entrega — três níveis

| Nível | Requisito | Protege contra |
|---|---|---|
| 0 · Monitoramento | Nenhum. Qualquer endereço via RPC | Nada — só alerta |
| 1 · Gate no SDK | Biblioteca local. Qualquer carteira | Raciocínio corrompido (injection, alucinação, tool misuse) |
| 2 · Co-assinatura | Chave separada do agente | Host comprometido |

**Neutralidade de carteira:** Squads é o caminho padrão para o nível 2, por ser programa nativo e não fornecedor contratado. Turnkey e Privy são atalho para quem já usa, nunca requisito.

**Limite físico assumido:** agente com chave crua na máquina não pode ser bloqueado por serviço externo. Isso é pré-requisito de segurança, não exigência do VETO.

## Benchmark Turnkey / Privy

Ambas têm mecanismo de aprovação por terceiro — `consensus` na Turnkey, quórum de chave na Privy. VETO entra como aprovador registrado, sem tocar em custódia.

As condições disponíveis nas duas são todas propriedades da transação isolada: endereço, ativo, valor, cadeia, timestamp. **Essa lista é a prova objetiva de que a camada de coerência não existe.**

## Remediação

Não desfaz. Transação confirmada não tem rollback.

| Ação | Dificuldade |
|---|---|
| Revogar delegate / approval | Baixa |
| Revogar session key | Baixa |
| Matar processo do agente | Baixa |
| Remover do multisig | Média |
| Varrer fundos — opcional, destino pré-autorizado pelo cliente | Média |

> Não dá para desfazer o que o agente fez. Dá para garantir que ele não faça de novo, em segundos em vez de horas.

## Decisões técnicas fechadas

**Rust:** apenas programa de registro de política e attestation das avaliações — log à prova de adulteração, sem autoridade sobre valor. Nunca custódia. Entra na última etapa.

**Rede neural:** camada 2, não POC. Modelo pontua, regra decide — para manter auditável. Entra quando houver baseline acumulado.

**Amigo de ML:** não recrutar agora. Manter informado, convidar quando houver algo rodando.

## Monetização

- Não segurar chave, não cobrar por custódia
- Piso fixo + basis points sobre valor avaliado
- Feed de threat intel como produto à parte
- Trilha de auditoria como desbloqueio de orçamento corporativo
- Sem token próprio
- **Fosso:** efeito de rede sobre o conjunto de regras — ataque bloqueado em um cliente vira detector para todos

**Provocação do professor a desenvolver:** modelo de garantia. *"Tentaram pegar X e vai me pagar Y."* Transforma segurança de custo em transferência de risco. Exige governança: critério de falha, processo de disputa, teto de exposição.

## Go-to-market

Publicar pesquisa de red team contra agentes públicos em Solana. O relatório é marketing, o SDK é aquisição, o co-signer é receita.

## Demo

1. Agente operando normal
2. Injection aplicada
3. **Deixar drenar — mostrar o dinheiro saindo**
4. Guarda ligado
5. Mesma injection → alerta com motivo específico
6. Bloqueio

O passo 3 é o que faz a demo funcionar.

# PARTE 2 — A DEFINIR

## Bloqueia o início do código

**Qual framework instrumentar.** Depende de: qual deles expõe a origem do contexto recuperado de forma utilizável. Solana Agent Kit tem mais alcance, ElizaOS tem mais histórico de incidente — mas a proveniência decide.

## Bloqueia a arquitetura de integração

**A aprovação por consenso da Turnkey aceita serviço externo automatizado em baixa latência, ou pressupõe humano?**

**A Privy aceita membro de quórum fora da organização do cliente?**

**Qual a latência do ciclo propor–aprovar–executar?** Define se atende agente de trading ou só de tesouraria.

→ Perguntar direto às empresas. Resposta comercial vale mais que documentação.

## Bloqueia o modelo de negócio

**Perfil de agente inicial:** trading, pagamento, tesouraria ou operações de DAO. Detecção genérica demais detecta mal — baseline de trading não se parece com baseline de pagamento.

**Modo de entrega no piloto:** SaaS, auto-hospedado ou híbrido.

**Números do preço:** qual piso, quantos bps, a partir de que patamar.

**Garantia:** como dimensionar sem quebrar no primeiro sinistro; qual estrutura jurídica no Brasil. *(Perguntar ao professor.)*

## Dados que faltam

**Valor sob controle de agente em Solana.** Existem dezenas de milhares de carteiras agênticas e Solana concentra ~65% do pagamento agêntico, mas não há número confiável de valor sob gestão autônoma.

**Perda acumulada em incidentes com agente em 2026** — proxy melhor de mercado endereçável que AUM.

**Quanto um protocolo gasta hoje para ativar um dev no stack dele** — referência para precificação.

## A confirmar tecnicamente

- Restrição do Lighthouse: funciona em `signTransaction`, não em `signAndSendTransaction` — confirmar na documentação
- Rent exato de uma attestation do SAS
- `simulateTransaction` retornando estado de conta e inner instructions como esperado

## Externo a monitorar

**ERC-8004** — padrão de identidade persistente e pontuação de credibilidade para agentes on-chain, sendo finalizado na Ethereum. Ameaça se comoditizar histórico de agente; oportunidade se o VETO for quem alimenta a pontuação.

**Fornecedores de AI runtime security** — Zenity, Sweet Security, IBM. Categoria consolidada em segurança corporativa. Risco: uma delas ligar um conector de blockchain.

## Logística

- Domínio e handles de "veto" — verificar disponibilidade e marca registrada
- Logo — direção visual ainda não fechada
- Qual hackathon e qual prazo
- Time: quem mais participa
- Decisão sobre horizonte: hackathon, projeto de pesquisa ou empresa *(não precisa ser respondida agora)*
