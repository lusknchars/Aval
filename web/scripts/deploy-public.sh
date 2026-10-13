#!/usr/bin/env bash
# Public deploy: landing page only (no console, no private Veto snapshots).
#   scripts/deploy-public.sh          → production deploy to Vercel (project "aval", aval-labs.vercel.app)
#   scripts/deploy-public.sh --build  → build dist-public/ only
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc -b
npx vite build --mode public --outDir dist-public --emptyOutDir
mkdir -p dist-public/app && cp public-only/app/index.html dist-public/app/index.html
# Guard: nothing from the console's private snapshots may ship.
if grep -rqs "trace-unlimited-approve\|trace-transfer-sol" dist-public; then echo "private snapshot found in dist-public" >&2; exit 1; fi
[[ "${1:-}" == "--build" ]] && exit 0
cd dist-public
[[ -d .vercel ]] || vercel link --yes --project aval >/dev/null
vercel deploy --prod --yes
