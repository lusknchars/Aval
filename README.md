# Aval

**A safety check that sits between an AI agent and its Solana wallet.**

An agent can be tricked by a web page, a tool result or its own mistake into
signing a transaction that breaks no wallet policy but is not what the user
asked for. Aval runs the unsigned transaction first, compares what it would
actually do with what the user asked for, and returns one of three verdicts:
**ALLOW**, **REVIEW** (a person looks) or **DENY**/**BLOCK**.

Built for the Superteam Brasil Solana hackathon (October 2026).

## Benchmark headline: 20k run on Solana mainnet

From [`reports/bench20k/summary.json`](reports/bench20k/summary.json) and
[`headline.json`](reports/bench20k/headline.json), finished 2026-10-11. Full report:
[`reports/aval-solana-report-20k.pdf`](reports/aval-solana-report-20k.pdf) (Portuguese).

| | Result |
|---|---|
| Real mainnet transactions | **22,686**, with **0 false blocks** |
| Code checks alone | approve 100% |
| With the model | **72.2%** approved automatically, **27.8%** sent to REVIEW, 0 blocked |
| Attacks forged on real transactions | **2,000 / 2,000** blocked |
| Constructed attacks (local VM) | **4,000 / 4,000** blocked |
| Their honest twins | **3,999 / 4,000** approved, 1 REVIEW, 0 blocked |
| Latency, code checks (layers A+B) | p50 **16 µs** (p95 35 µs) |
| Latency, model (layer C) | p50 **about 1.4 s** (p95 3.6 s, MLX on an M4 Pro) |

### Limitations: read these with the numbers

- **The attacks are forged test cases.** The 2,000 "attacks on real transactions"
  are real mainnet transactions paired with a forged user intent that they
  contradict, plus test-only injected text. The 4,000 constructed attacks run in
  the local VM. None of them is a captured real-world attack.
- **The code catches match the labels by construction.** Layer A labels a case by
  the same comparison of intent against simulated effects that it uses to decide,
  so its 100% shows the mechanism works end to end, not independent skill. The
  independent measure is the model on its own (see `lab/README.md`, "Treino local
  com MLX" and the 1,000-transaction report).
- **The model scored a sample.** It runs at under one case per second,
  which fell behind the collector, so from 2026-10-11 09:34 UTC it scored a seeded
  sample (seed 20261010: 60% of real traffic, 50% of constructed cases).
  It scored 15,076 of the 22,686 real transactions (66.5%); the other 7,610 show
  the code-only result. Of the ones it scored, 58.1% were approved and 41.9% went
  to REVIEW, mostly swaps (86% of the model-scored swaps went to REVIEW).
- **REVIEW is a cost.** No honest transaction was blocked, but more than a quarter
  of real traffic would wait for a person.
- **Cerrado Capital**, the company shown in the web console, is fictional demo data.

## How the parts fit

```
            user request                                     web/  (landing + operator console)
                 │                                           :4173  /app/#/live  /app/#/replay/focus
                 ▼                                              │  proxies /veto  /svm  /lab
          AI agent (client's runtime)                           │
                 │ context + tool call + unsigned tx            │
                 ▼                                              │
   ┌──────────────────────────────┐   simulateTransaction   ┌───┴──────────────────────────┐
   │ engine/   (Eric, TypeScript) │ ──────────────────────▶ │ lab/svm  aval-svm (Rust)     │
   │ provenance of every context  │                         │ local Solana VM (LiteSVM),   │
   │ chunk, effects vs. request,  │ ◀────────────────────── │ accounts cached from mainnet │
   │ deterministic verdict  :5173 │      effects, digest    │ RPC (Helius)          :8899  │
   └──────────────┬───────────────┘                         └───┬──────────────────────────┘
                  │ verdict records (JSONL)                     │
                  ▼                                             ▼
   ┌──────────────────────────────┐                     ┌──────────────────────────────┐
   │ lab/registry  aval-registry  │                     │ lab/  (Python)  API   :8070  │
   │ Anchor program: Merkle roots │                     │ layer A simulation + labels, │
   │ of verdict batches on chain; │                     │ B injection patterns,        │
   │ `aval-svm anchor` / `verify` │                     │ C fine-tuned model (may only │
   └──────────────────────────────┘                     │ tighten), benchmark, dataset │
                                                        └──────────────────────────────┘
```

- **`engine/`**: the core library. It captures context as it enters the agent,
  with where each piece came from, and checks the unsigned transaction before the
  wallet signs. It runs `simulateTransaction`, reads the effects and decides with
  deterministic rules; no LLM sits in its decision path. `pnpm demo` shows every
  stage on one page. See [`engine/README.md`](engine/README.md).
- **`lab/`**: the research lab and its Python API (`src.unified_api`, port 8070):
  layers A/B/C, the adversarial evaluation, the training dataset built from real
  transactions, local MLX fine-tuning of the model, and the 1,000 and 20,000
  benchmarks. See [`lab/README.md`](lab/README.md) (Portuguese).
  - **`lab/svm/`**: `aval-svm`, a JSON-RPC-compatible local Solana VM. Optional
    cross-check against a second RPC provider, which fails closed when they disagree.
  - **`lab/registry/`**: `aval_registry`, an Anchor program that stores Merkle roots
    of verdict batches so any single verdict can later be proven unaltered.
- **`web/`**: the public landing page and the operator console (live gate,
  replay, runs, issues).
- **`reports/`**: benchmark reports and summaries. **`docs/`**: links to the specs.

## Who built what

Commit history is preserved for every folder (`git log -- engine/`, `git shortlog -sn -- lab/`).

| Folder | Built by |
|---|---|
| `engine/` | **Eric Ferraz** ([@ericferrazp](https://github.com/ericferrazp)), all 40 commits |
| `lab/` | **Luis Pessoa** ([@Luispessoa18](https://github.com/Luispessoa18)) started it: VETO Lab, the fine-tuned security model, the adversarial evaluation suite, the Solana admin dashboard. **Lucas Oliveira** ([@lusknchars](https://github.com/lusknchars)) added `svm/`, `registry/`, the dataset, MLX training and the benchmarks |
| `web/` | **Lucas Oliveira** |

`lab/` comes from [Luispessoa18/veto-lab-2](https://github.com/Luispessoa18/veto-lab-2)
(branch `feat/benchmark-20k`, merged here with `feat/rpc-quorum`, PR #4).

## Run the demo locally

Requirements: Node 22+, pnpm 12 (`npx -y pnpm@12.4.2`), Rust stable (1.97.1 or newer),
Python 3.11+, and a Helius (or other mainnet) RPC URL. For the registry, the Solana CLI
(Agave) and Anchor.

**1. Engine on :5173**

```bash
cd engine
cp .env.example .env        # set AVAL_RPC_URL to your Helius mainnet URL; .env is git-ignored
npx -y pnpm@12.4.2 install
npx -y pnpm@12.4.2 demo     # http://127.0.0.1:5173
```

**2. aval-svm on :8899**

```bash
cd lab/svm
cargo build --release
AVAL_UPSTREAM_URL="https://mainnet.helius-rpc.com/?api-key=<your key>" \
  ./target/release/aval-svm serve --config aval-svm.toml      # 127.0.0.1:8899
```

**3. Lab API on :8070**

```bash
cd lab
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m src.unified_api --host 127.0.0.1 --port 8070
```

The model layer needs the model files (see Models below); without them the
code layers still answer.

**4. Web console on :4173**

```bash
cd web
npm ci
npm run local      # builds, then serves on 127.0.0.1:4173
```

Open `http://127.0.0.1:4173/app/#/live` (live gate) and
`http://127.0.0.1:4173/app/#/replay/focus` (replay). The console proxies `/veto`,
`/svm` and `/lab` to the three services above; override with `VETO_URL`, `SVM_URL`, `LAB_URL`.

**5. Registry on a local validator (zero cost)**

```bash
cd lab
registry/scripts/localnet.sh --demo-records        # validator on :8999, program loaded, results/demo-records.jsonl
export AVAL_REGISTRY_RPC=http://127.0.0.1:8999
./svm/target/release/aval-svm anchor --records results/demo-records.jsonl \
    --keypair ~/.config/solana/id.json --once
./svm/target/release/aval-svm verify --records results/demo-records.jsonl --line 7 \
    --authority $(solana-keygen pubkey ~/.config/solana/id.json)   # retry after ~15 s if PENDING
registry/scripts/localnet.sh --stop
```

The program keypair is never committed: on a clean clone the script loads the
committed `.so` fixture into genesis under the same program id.

## Models

Large model files are not in this repo, except one older adapter (see below).

- Base model for layer C: Luis's merged Qwen2.5-Coder-1.5B-Instruct (bf16), plus
  the LoRA trained here (`veto-svm`, iteration 300). Training commands are in
  `lab/scripts/train_mlx.sh` and the LoRA config is in `lab/config/mlx_lora_svm.yaml`.
  Outputs go to `lab/models/veto-*`, which is git-ignored.
- Prompt Guard and Gemma GGUF: `lab/baixar_modelos.sh` (Hugging Face; Prompt Guard
  needs an accepted license and `HF_TOKEN`).
- `lab/models/VETO-Security-LoRA-F16.gguf` (57 MB) has been in Luis's repository
  since its first commit, so it is in this repo's history too.

## Reports

| File | What |
|---|---|
| `reports/aval-solana-report-20k.pdf` | 20k mainnet benchmark (the headline above) |
| `reports/aval-solana-report-1000.pdf` | 1,000-transaction benchmark on fresh data, model vs. code |
| `reports/aval-solana-report-demo.pdf` | snapshot of the 20k run, demo mode |
| `reports/bench20k/summary.json` | final per-set counts, decided-by layer, latency |
| `reports/bench20k/headline.json` | the four headline numbers + combined A+B latency |
| `reports/bench20k/cases_meta.json` | how the cases were drawn: seed, exclusions, attack kinds |

The raw streams behind them, `cases.jsonl` (≈78 MB, 32,686 cases) and
`events.jsonl` (≈24 MB, 54,463 events), are not committed. Regenerate them with
`lab/scripts/run_bench20k.sh`; the lab API also serves them read-only under
`/v1/benchmark` (see `lab/docs/benchmark-api.md`).

## Tests

CI (`.github/workflows/ci.yml`) runs each part in its own folder:

| Part | Command |
|---|---|
| engine | `npx -y pnpm@12.4.2 install --frozen-lockfile && pnpm test && pnpm typecheck` |
| lab/svm | `cargo test --locked` and `cargo clippy --all-targets --locked -- -D warnings` |
| lab | `python -m unittest discover -s tests` |
| web | `npm ci && npm run typecheck && npm run build` |
