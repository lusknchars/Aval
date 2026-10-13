# Docs

The specs live next to the code they describe; this page links to them so they
keep one copy and their history.

## Engine (TypeScript core)

- [engine/docs/aval-camada-avaliacao.md](../engine/docs/aval-camada-avaliacao.md): the evaluation layer
- [engine/docs/aval-construcao.md](../engine/docs/aval-construcao.md): how it is built
- [engine/docs/decisions.md](../engine/docs/decisions.md): design decisions
- [engine/docs/demo.md](../engine/docs/demo.md): demo walkthrough
- [engine/docs/fluxo.svg](../engine/docs/fluxo.svg): flow diagram
- [engine/docs/aval-status.md](../engine/docs/aval-status.md), [backlog.md](../engine/docs/backlog.md), [pending.md](../engine/docs/pending.md)
- [engine/SETUP.md](../engine/SETUP.md): toolchain

## aval-svm and aval-registry

- [lab/svm/docs/2026-10-06-aval-svm-design.md](../lab/svm/docs/2026-10-06-aval-svm-design.md): local Solana VM, including the two-provider cross-check
- [lab/svm/docs/2026-10-06-aval-registry-design.md](../lab/svm/docs/2026-10-06-aval-registry-design.md): on-chain attestation of verdicts (Anchor + Merkle)

## Lab

- [lab/README.md](../lab/README.md): setup, dataset, MLX training, the 1,000 benchmark, registry, endpoints
- [lab/docs/benchmark-api.md](../lab/docs/benchmark-api.md): read-only `/v1/benchmark` endpoints for the 20k run
- [lab/AVALIACAO_E_TESTES.md](../lab/AVALIACAO_E_TESTES.md): evaluation and tests
- [lab/CONFIGURAR_AVAL.md](../lab/CONFIGURAR_AVAL.md): configuration
- [lab/STRESS_TEST_SANDUICHE.md](../lab/STRESS_TEST_SANDUICHE.md): sandwich (MEV) stress-test proposal
