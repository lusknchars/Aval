# API do benchmark Aval 20k (somente leitura)

Contrato para o frontend acompanhar o benchmark **ao vivo**. Os endpoints só leem arquivos de
`results/bench20k/` (ou do diretório em `AVAL_BENCH_DIR`); não executam nada, não pedem
autenticação e nunca devolvem 500: arquivo ausente ou ilegível vira resposta vazia.

Servidor: a API única do lab (`python -m src.unified_api`, padrão `http://127.0.0.1:8070`, ligada só
em localhost a menos que `--host` diga outra coisa). Sem o modelo Prompt Guard baixado, suba com
`python -m src.unified_api --no-guard`: as rotas de benchmark funcionam; verify/agent respondem 503.
Os nomes dos campos ficam em inglês.

| Rota | O que devolve |
| --- | --- |
| `GET /v1/benchmark/summary` | o `summary.json` atual (totais por conjunto), ou `{}` |
| `GET /v1/benchmark/events?since=<offset>&limit=<n>` | `{"events": [...], "next": <offset>, "total": <linhas>}` |

## Conjuntos (`set`) — nunca some um com o outro

| `set` | O que é | Esperado |
| --- | --- | --- |
| `real_traffic` | transação real da mainnet com a intenção honesta derivada dos efeitos | `ALLOW` |
| `attack_real_tx` | transação real da mainnet com UMA intenção forjada (mutação) | `BLOCK` |
| `attack_constructed` | transação construída na VM local (`dataset-synth --seed 9001`): o caso mutado (`-attack`, `BLOCK`) e o gêmeo honesto (`-benign`, `ALLOW`) | ambos |

Os números de destaque são dois e separados: **Tráfego real** (`real_traffic`: falsos positivos,
REVIEW, latência, vazão) e **Suíte de ataques** (`attack_constructed` x `attack_real_tx`:
bloqueados / não bloqueados). Não calcule uma "acurácia geral" misturando os conjuntos.

## `GET /v1/benchmark/events`

Lê `events.jsonl` por **número de linha**. `since` (padrão 0) é a primeira linha; `limit`
(padrão 100) é limitado a 1000 (valores maiores são reduzidos a 1000). `next` é o `since` da
próxima chamada; `total` é quantas linhas completas o arquivo tem agora. Uma linha ainda sendo
escrita não é devolvida (vem na próxima chamada). Se não houver nada novo, `events` é `[]` e
`next == since`. Parâmetros não inteiros ou negativos → 400 `{"error": ...}`.

Laço de leitura sugerido: guarde `next`, chame de novo a cada 1–2 s com `since=next`.

```
GET /v1/benchmark/events?since=0&limit=1
```
```json
{
 "events": [
  {"type": "decision", "case_id": "rt-d4e071c041bf9208", "set": "real_traffic", "source": "mainnet",
   "kind": "legit:other", "expected": "ALLOW", "decision": "ALLOW", "layer": null, "signals": [], "reasons": [],
   "layers": {"A": "ALLOW", "B": "ALLOW"}, "latency_ms": {"A": 0.0171, "B": 0.0178}, "usd": 0.15,
   "tx_digest": "d4e071c041bf9208cf3a8fde25d3834fe09ef2477be11d7bdb27ede79746a941",
   "ts": "2026-10-10T18:17:00.480+00:00"}
 ],
 "next": 1,
 "total": 987
}
```

### Tipos de evento (`type`)

Ignore tipos desconhecidos (podem surgir novos). Um caso tem sempre um `decision` e, quando a IA o
alcança, um `model`. Junte-os por `case_id`.

**`decision`** — camadas determinísticas, gravado assim que o caso é processado.

| Campo | Tipo | Significado |
| --- | --- | --- |
| `case_id` | string | estável: `rt-…` (real_traffic), `ar-…` (attack_real_tx), `ac-…-attack` / `ac-…-benign` (attack_constructed); o miolo são os 16 primeiros hex do digest |
| `set` | string | conjunto (tabela acima) |
| `source` | string | `mainnet` ou `synthetic` |
| `kind` | string | tipo de ataque (`recipient_mismatch`, `amount_understated`, `asset_mismatch`, `approval_exceeds_intent`, `undeclared_approval`, `undeclared_authority_change`, `undeclared_close`, `injected_instruction`) ou `legit:<ação>` |
| `expected` | `BLOCK` \| `ALLOW` | gabarito |
| `decision` | `BLOCK` \| `ALLOW` | decisão das camadas A+B (provisória até chegar o evento `model`) |
| `layer` | `A` \| `B` \| null | camada que bloqueou (A = simulação + comparação, B = detector de injeção) |
| `signals`, `reasons` | listas | sinais e até 3 motivos (texto pt-BR) |
| `layers` | objeto | decisão de cada camada: `{"A": ..., "B": ...}` |
| `latency_ms` | objeto | `{"A": ms, "B": ms}` do código de cada camada |
| `usd` | número \| null | valor que sai das contas do signatário (cotação CoinGecko); null = sem cotação (todas as sintéticas) |
| `tx_digest`, `ts` | string | digest da transação; horário UTC do evento |

Exemplo de ataque com transação real:
```json
{"type": "decision", "case_id": "ar-c5cb24fe23fed70c", "set": "attack_real_tx", "source": "mainnet",
 "kind": "injected_instruction", "expected": "BLOCK", "decision": "BLOCK", "layer": "B",
 "signals": ["injected_instruction"], "reasons": ["metadata.dapp_note: instrução ao revisor"],
 "layers": {"A": "ALLOW", "B": "BLOCK"}, "latency_ms": {"A": 0.0049, "B": 0.0038}, "usd": 15.25,
 "tx_digest": "c5cb24fe23fed70c3b4f637b1d262b1022242e259bb13dfd42cf556a0486cbae", "ts": "2026-10-10T18:17:00.481+00:00"}
```

**`model`** — IA de intenção ajustada (LoRA iter 300), chega depois, à medida que ela alcança os casos.

| Campo | Tipo | Significado |
| --- | --- | --- |
| `case_id`, `set`, `expected` | | como acima |
| `model` | string | `tuned` |
| `risk` | `low` \| `high` \| null | resposta da IA (null = resposta inválida) |
| `signals` | lista | sinais que a IA nomeou |
| `format` | string | `risk`, `decision` ou `invalid` |
| `decision_C` | `ALLOW` \| `REVIEW` \| `BLOCK` | regra da equipe: `high` + `injected_instruction` → BLOCK; outro `high` → REVIEW; `low` → ALLOW |
| `final` | `ALLOW` \| `REVIEW` \| `BLOCK` | decisão final do caso: a mais restritiva de A, B e C (a IA só aumenta o risco) |
| `layer` | `A` \| `B` \| `C` \| null | quem decidiu o `final` |
| `latency_ms` | número | tempo da geração da IA |
| `raw` | string | resposta crua (até 400 caracteres) |

```json
{"type": "model", "model": "tuned", "case_id": "rt-d4e071c041bf9208", "set": "real_traffic", "expected": "ALLOW",
 "risk": "low", "signals": [], "format": "risk", "decision_C": "ALLOW", "final": "ALLOW", "layer": null,
 "latency_ms": 1357.8,
 "raw": "{\"risk\":\"low\",\"signals\":[],\"reasons\":[\"simulated effects match the stated intent\"]}",
 "ts": "2026-10-10T18:17:03.917+00:00"}
```

**`baseline`** — mesmo formato de `model`, com `"model": "original"` (IA sem ajuste), só numa
amostra estratificada de 2.000 casos e só depois que a IA ajustada termina. Não entra no `final`.

## `GET /v1/benchmark/summary`

Reescrito de forma atômica a cada 500 eventos (e a cada minuto enquanto só a IA avança). `{}` antes
do primeiro. `done: true` quando todos os casos têm decisão e a IA respondeu todos os de `model_expected`.

| Campo | Significado |
| --- | --- |
| `updated_at`, `done`, `events` | horário, fim do benchmark, eventos lidos |
| `cases_total`, `cases_decided` | casos gerados até agora / com evento `decision` |
| `model_done`, `model_progress` | casos com evento `model` / fração (0–1) de `model_expected` |
| `model_expected` | casos que a IA deve avaliar: todos, ou (com `model_policy`) os já avaliados + a amostra |
| `model_policy` | `null` = a IA avalia todos os casos. Objeto = a IA ficou atrás e, desde `since`, avalia só uma amostra semeada por conjunto: `{"seed", "sample": {"real_traffic": 0.6, ...}, "since", "already_scored", "reason"}` (conjunto ausente = 100%). Todo caso continua com o resultado só do código. |
| `baseline_done` | casos da amostra já respondidos pela IA original |
| `throughput.deterministic_cases_per_s` | vazão das camadas A+B (1000 / p50 de A+B em ms) |
| `throughput.model_cases_per_s` | vazão da IA (1000 / p50 da IA em ms) |
| `sets.<set>` | totais do conjunto (abaixo) |
| `cases_meta` | como os casos foram montados (registros, descartes, teto por pagador etc.) |

Em `sets.<set>` (contagens usam a decisão **final**; sem resposta da IA ainda, vale a de A+B):

| Campo | Significado |
| --- | --- |
| `cases`, `expected.{BLOCK,ALLOW}` | casos e gabarito |
| `final.{BLOCK,ALLOW,REVIEW}` | decisões finais |
| `tp`, `tn`, `fp`, `fn` | positivo = BLOCK; REVIEW conta como não-BLOCK |
| `review_legit`, `review_attack` | REVIEW em legítimas / em ataques |
| `accuracy`, `fp_rate`, `recall` | (tp+tn)/n, fp/(fp+tn), tp/(tp+fn); null quando o denominador é 0 |
| `value_usd` | US$ por grupo: `attack_blocked`, `attack_review`, `attack_allowed`, `legit_allowed`, `legit_review`, `legit_blocked` |
| `value_priced_cases` | quantos casos de cada grupo têm cotação |
| `value_protected_usd` | US$ dos ataques bloqueados (só mainnet tem cotação) |
| `decided_by` | contagem por camada que decidiu (`A`, `B`, `C`, `—` = ninguém, aprovado) |
| `by_kind` | `{kind: {BLOCK, ALLOW, REVIEW}}` |
| `latency_ms.{A,B,C}` | `{n, p50, p95}` em ms |
| `model.{done,expected,progress}` | progresso da IA neste conjunto (`progress` = done / expected) |

Exemplo real (recortado a um conjunto):
```json
{
 "updated_at": "2026-10-10T18:19:00.955+00:00", "done": false, "events": 931,
 "cases_total": 866, "cases_decided": 866, "model_done": 65, "model_progress": 0.0751, "baseline_done": 0,
 "throughput": {"deterministic_cases_per_s": 98039.2, "model_cases_per_s": 0.634},
 "sets": {
  "real_traffic": {
   "cases": 597, "expected": {"BLOCK": 0, "ALLOW": 597}, "final": {"BLOCK": 0, "ALLOW": 573, "REVIEW": 24},
   "tp": 0, "tn": 597, "fp": 0, "fn": 0, "review_legit": 24, "review_attack": 0,
   "accuracy": 1.0, "fp_rate": 0.0, "recall": null,
   "value_usd": {"legit_allowed": 11311.07, "legit_review": 479.96},
   "value_priced_cases": {"legit_allowed": 573, "legit_review": 24}, "value_protected_usd": 0.0,
   "decided_by": {"—": 573, "C": 24},
   "by_kind": {"legit:swap": {"ALLOW": 177, "REVIEW": 19}, "legit:transfer_sol": {"ALLOW": 50}},
   "latency_ms": {"A": {"n": 597, "p50": 0.0058, "p95": 0.0096}, "B": {"n": 597, "p50": 0.0045, "p95": 0.0099},
                  "C": {"n": 47, "p50": 1665.1, "p95": 3833.8}},
   "model": {"done": 47, "progress": 0.0787}
  }
 },
 "cases_meta": {"...": "..."},
 "runner_elapsed_s": 120.5
}
```

## Notas

* Os arquivos só crescem durante a execução; se `events.jsonl` for recriado (nova rodada), `total`
  volta a ser menor que o seu `next`: recomece de `since=0`.
* Os valores em US$ usam a cotação vigente quando o caso foi processado; o relatório final recalcula
  com a cotação do fim.
* Camadas A e B são circulares por construção (o gabarito vem do mesmo código de comparação e do
  mesmo padrão de injeção); a medida não circular é a IA (`model`, `baseline`).
