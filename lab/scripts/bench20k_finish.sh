#!/usr/bin/env bash
# Espera a coleta do benchmark 20k terminar; se ela parou por meta ou orçamento (não por erro),
# preenche decimais (backfill) e marca results/bench20k/collection_done para o construtor de casos.
set -uo pipefail
LOG=results/bench20k/collect.log
while pgrep -f "aval-svm dataset --target" > /dev/null; do sleep 60; done
last=$(grep -E "^(done|stopped):" $LOG | tail -2)
echo "$(date -u +%FT%TZ) collector exited: $last"
read -r kept target <<< "$(echo "$last" | tail -1 | sed -nE 's/.*kept ([0-9]+)\/([0-9]+) .*/\1 \2/p')"
if echo "$last" | grep -q "^stopped: call budget" || { [ -n "${kept:-}" ] && [ "${kept:-0}" -ge "${target:-1}" ]; }; then
  ./scripts/run_bench20k.sh backfill 2>&1 | grep -v litesvm
  touch results/bench20k/collection_done
  echo "$(date -u +%FT%TZ) collection_done"
else
  echo "$(date -u +%FT%TZ) collector did not reach its target or budget; not marking done"
  exit 1
fi
