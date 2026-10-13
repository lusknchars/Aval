#!/usr/bin/env bash
# Public demo: the console alone, static, on recorded engine verdicts (no backend).
#   scripts/deploy-demo.sh          → production deploy to Vercel (project "aval-demo", aval-demo.vercel.app)
#   scripts/deploy-demo.sh --build  → build dist-demo/ only
# The landing page stays on scripts/deploy-public.sh (project "aval").
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc -b
npx vite build --mode demo --outDir dist-demo --emptyOutDir
cp demo-only/index.html dist-demo/index.html
# Guard: no key, local path or keyed RPC URL may ship.
if grep -rIl "api-key\|/Users/\|helius-rpc.com/?" dist-demo; then echo "secret or local path found in dist-demo (files above)" >&2; exit 1; fi
echo "guard: dist-demo clean (api-key, /Users/, helius-rpc.com/?)"
[[ "${1:-}" == "--build" ]] && exit 0
cd dist-demo
[[ -d .vercel ]] || vercel link --yes --project aval-demo >/dev/null
vercel deploy --prod --yes
