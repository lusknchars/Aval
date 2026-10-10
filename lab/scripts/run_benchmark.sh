#!/usr/bin/env bash
# Benchmark de 1000 transações do Aval (A: simulação + comparação, B: detector de injeção, C: IA ajustada)
# em dados NUNCA usados no treino, e relatório PT-BR (HTML + PDF). Custo zero: nada é assinado nem enviado.
# Rode da raiz do repo. Passos longos: use `caffeinate -i` (o Mac dormiu no treino).
#   ./scripts/run_benchmark.sh [collect|synth|cases|model|prices|report|pdf|all]
set -euo pipefail
SVM=svm/target/release/aval-svm
PY=.venv/bin/python
MLX=.venv-mlx/bin/python
UPSTREAM=${AVAL_UPSTREAM_URL:-https://api.mainnet-beta.solana.com}
OUT=results/benchmark
mkdir -p $OUT
step=${1:-all}

collect() {
  # Transações mainnet novas (arquivo NOVO); as que já estão no treino são descartadas no passo cases.
  $SVM dataset --upstream "$UPSTREAM" --target ${TARGET:-700} --out results/bench_effects_mainnet.jsonl \
    --delay-ms 400 --max-blocks 900 2>&1 | tee $OUT/collect_mainnet.log
  $SVM dataset --upstream "$UPSTREAM" --backfill-decimals --in results/bench_effects_mainnet.jsonl \
    --out results/bench_effects_mainnet.v2.jsonl --delay-ms 400 2>&1 | tee -a $OUT/collect_mainnet.log
}

synth() {
  # Seed diferente do treino (42); --timings cronometra cada simulação no motor do aval-svm.
  $SVM dataset-synth --count 600 --seed 777 --out results/bench_effects_synth.jsonl --timings $OUT/synth_sim_timings.jsonl
}

cases() {
  $PY -m src.aval_benchmark cases --mainnet results/bench_effects_mainnet.v2.jsonl \
    --synthetic results/bench_effects_synth.jsonl \
    --exclude results/svm_effects.v2.jsonl results/svm_effects.jsonl results/svm_effects_synth.jsonl
}

model() {
  # Retomável: casos já respondidos são pulados.
  $MLX -m src.aval_benchmark model --name tuned --adapter models/veto-svm-lora 2>&1 | tee $OUT/model_tuned.log
  $MLX -m src.aval_benchmark model --name original 2>&1 | tee $OUT/model_original.log
}

prices() { $PY -m src.aval_benchmark prices; }

report() { $PY -m src.aval_benchmark report; }

pdf() {
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
    --print-to-pdf="$PWD/$OUT/relatorio_aval_1000.pdf" "file://$PWD/$OUT/relatorio_aval_1000.html"
}

case $step in
  collect) collect ;; synth) synth ;; cases) cases ;; model) model ;; prices) prices ;; report) report ;; pdf) pdf ;;
  all) collect; synth; cases; model; prices; report; pdf ;;
  *) echo "uso: $0 [collect|synth|cases|model|prices|report|pdf|all]"; exit 2 ;;
esac
