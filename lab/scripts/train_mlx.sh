#!/usr/bin/env bash
# Treino local (Apple Silicon, MLX) do modelo VETO de Luis no dataset aval-svm. Custo zero, nada sai da máquina.
# Rode da raiz do repo. Cada passo grava log em results/train/ e métricas em results/eval/.
set -euo pipefail
PY=.venv-mlx/bin
BASE=models/veto-merged-bf16          # modelo merged bf16 de Luis (Drive, pasta gguf-model/)
ADAPTER=models/veto-svm-lora
FUSED=models/veto-svm-fused
DATA=results/svm_dataset
mkdir -p results/train results/eval

# 0. Ambiente (uma vez)
# /opt/homebrew/bin/python3 -m venv .venv-mlx && $PY/pip install mlx-lm gdown gguf numpy pytest
# Download só dos arquivos de gguf-model/ (ids via gdown.download_folder(..., skip_download=True)):
#   config.json generation_config.json model.safetensors tokenizer.json tokenizer_config.json chat_template.jinja

step=${1:-all}

baseline() {
  for split in mainnet synthetic; do
    $PY/python -m src.eval_risk --model $BASE --data $DATA/test_$split.jsonl --name baseline_$split \
      2>&1 | tee results/train/eval_baseline_$split.log
  done
}

train() {
  # 1779 exemplos / batch 8 ≈ 222 iters por época → 450 iters ≈ 2 épocas.
  # --grad-checkpoint: sem ele, batch 8 × 2560 tokens estoura a memória Metal (48 GB, M4 Pro).
  /usr/bin/time -p $PY/mlx_lm.lora --model $BASE --train --data $DATA -c config/mlx_lora_svm.yaml \
    --fine-tune-type lora --num-layers -1 --batch-size 8 --iters 450 --learning-rate 1e-4 \
    --mask-prompt --grad-checkpoint --steps-per-eval 50 --steps-per-report 10 --save-every 100 \
    --adapter-path $ADAPTER 2>&1 | tee results/train/train.log
  # Parada antecipada (manual): se a val loss subir em 2 avaliações seguidas, interrompa e use o melhor
  # checkpoint salvo. Rodada de 2026-10-08: val 0.056 @300 → 0.058 @350 → 0.072 @400, parada em ~420:
  #   cp $ADAPTER/adapters.safetensors $ADAPTER/last_iter400_adapters.safetensors
  #   cp $ADAPTER/0000300_adapters.safetensors $ADAPTER/adapters.safetensors
}

tuned() {
  for split in mainnet synthetic; do
    $PY/python -m src.eval_risk --model $BASE --adapter $ADAPTER --data $DATA/test_$split.jsonl --name tuned_$split \
      2>&1 | tee results/train/eval_tuned_$split.log
  done
}

fuse() {
  $PY/mlx_lm.fuse --model $BASE --adapter-path $ADAPTER --save-path $FUSED 2>&1 | tee results/train/fuse.log
}

gguf() {
  # mlx_lm.fuse --export-gguf só exporta llama/mistral/mixtral; para Qwen2 usamos o conversor do llama.cpp.
  # LLAMA_CPP = clone esparso (conversion/ gguf-py/ requirements/) do github.com/ggml-org/llama.cpp, FORA do repo;
  # venv própria (.venv-gguf) porque ele fixa transformers 4.57 / torch 2.11:
  #   python3 -m venv .venv-gguf && .venv-gguf/bin/pip install -r $LLAMA_CPP/requirements/requirements-convert_hf_to_gguf.txt
  # transformers 5 grava extra_special_tokens como lista, que o 4.57 não lê: o stage troca por additional_special_tokens.
  : "${LLAMA_CPP:?defina LLAMA_CPP=<clone do llama.cpp>}"
  local stage; stage=$(mktemp -d)
  for f in "$PWD/$FUSED"/*; do ln -s "$f" "$stage/"; done
  rm "$stage/tokenizer_config.json"
  python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); t["additional_special_tokens"]=t.pop("extra_special_tokens",[]); json.dump(t,open(sys.argv[2],"w"),ensure_ascii=False,indent=1)' \
    "$FUSED/tokenizer_config.json" "$stage/tokenizer_config.json"
  PYTHONPATH=$LLAMA_CPP/gguf-py:$LLAMA_CPP .venv-gguf/bin/python $LLAMA_CPP/convert_hf_to_gguf.py "$stage" \
    --outtype f16 --outfile models/veto-svm-f16.gguf 2>&1 | tee results/train/gguf.log
  rm -rf "$stage"
  if command -v llama-quantize >/dev/null; then
    llama-quantize models/veto-svm-f16.gguf models/veto-svm-Q4_K_M.gguf Q4_K_M 2>&1 | tee -a results/train/gguf.log
  else
    echo "llama-quantize ausente: fica só o f16" | tee -a results/train/gguf.log
  fi
}

case $step in
  baseline) baseline ;; train) train ;; tuned) tuned ;; fuse) fuse ;; gguf) gguf ;;
  all) baseline; train; tuned; fuse; gguf ;;
  *) echo "uso: $0 [baseline|train|tuned|fuse|gguf|all]"; exit 2 ;;
esac
