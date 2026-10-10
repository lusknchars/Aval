#!/usr/bin/env bash
# Depois que o executor em streaming termina (todos os casos com decisão e resposta da IA):
# IA original na amostra de 2.000, cotações finais, relatório HTML + PDF e cópia para Documentos.
set -euo pipefail
OUT=results/bench20k
while pgrep -f "aval_benchmark --stream" > /dev/null; do sleep 120; done
python3 -c "import json,sys; sys.exit(0 if json.load(open('$OUT/summary.json')).get('done') else 1)" \
  || { echo "stream exited before done; not reporting"; exit 1; }
.venv-mlx/bin/python -m src.bench20k baseline
.venv/bin/python -m src.bench20k prices || echo "prices failed; using the previous prices.json"
.venv/bin/python -m src.bench20k report
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/$OUT/relatorio_aval_20k.pdf" "file://$PWD/$OUT/relatorio_aval_20k.html"
cp "$OUT/relatorio_aval_20k.pdf" "/Users/luskoliveira/Documents/Relatório Aval Solana 20k.pdf"
echo "$(date -u +%FT%TZ) report done"
