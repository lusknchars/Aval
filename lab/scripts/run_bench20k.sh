#!/usr/bin/env bash
# Benchmark Aval 20k: tráfego real da mainnet (Helius, plano grátis) + suíte de ataques, em streaming.
# A chave fica em .env.helius (modo 600, fora do git) e nunca é impressa: a URL vai só pelo ambiente
# (AVAL_UPSTREAM_URL, nunca na linha de comando, que aparece no ps) e os logs mostram só o host.
#   caffeinate -i ./scripts/run_bench20k.sh [collect|backfill|synth|cases|stream|report|pdf]
set -euo pipefail
SVM=svm/target/release/aval-svm
PY=.venv/bin/python
MLX=.venv-mlx/bin/python
OUT=results/bench20k
RAW=results/bench20k_effects_mainnet.jsonl
mkdir -p $OUT
step=${1:-}

collect() {
  # 9 req/s (limite do plano: 10), orçamento de chamadas; retomável (digests já gravados são pulados).
  . ./.env.helius
  AVAL_MAX_RPS=${AVAL_MAX_RPS:-9} $SVM dataset --target ${TARGET:-28000} \
    --out $RAW --delay-ms 0 --per-block 100 --concurrency ${CONCURRENCY:-4} --max-blocks 100000 --max-calls ${MAX_CALLS:-380000} \
    --exclude results/svm_effects.jsonl results/svm_effects.v2.jsonl results/bench_effects_mainnet.jsonl \
      results/bench_effects_mainnet.v2.jsonl results/svm_effects_synth.jsonl results/bench_effects_synth.jsonl
}

backfill() {
  . ./.env.helius
  AVAL_MAX_RPS=${AVAL_MAX_RPS:-9} $SVM dataset --backfill-decimals \
    --in $RAW --out results/bench20k_effects_mainnet.v2.jsonl --delay-ms 0
}

synth() { $SVM dataset-synth --count 4000 --seed 9001 --out $OUT/synth_effects.jsonl --timings $OUT/synth_sim_timings.jsonl; }

case $step in
  collect) collect ;; backfill) backfill ;; synth) synth ;;
  *) echo "uso: $0 [collect|backfill|synth]"; exit 2 ;;
esac
