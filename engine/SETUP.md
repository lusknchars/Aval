# SETUP

How the environment is put together, why each choice was made, and how to
verify it works.

This covers the toolchain only. The product itself is described in `README.md`;
design specifications live in `docs/`.

---

## 1. Requirements

| Tool | Minimum | Verified on this machine |
|---|---|---|
| Node.js | 20 | v26.7.0 |
| pnpm | 10 | 12.4.2 |
| git | — | 2.52.0 |

`package.json` requires Node >= 20 through `engines`, and `.npmrc` sets
`engine-strict=true`, which turns that into an install error rather than an
ignored warning.

> Node 20 went out of support in April 2026. The floor is 20 because that is
> what the project targets, but develop on 22 or newer.

`corepack`, which used to ship pnpm alongside Node, was removed from recent
releases. Install pnpm globally:

```bash
npm install -g pnpm
```

---

## 2. What is installed and why

### Runtime dependencies

| Package | Version | Role in VETO |
|---|---|---|
| `@solana/web3.js` | `^1.99.0` | `simulateTransaction` with `accounts` and `innerInstructions` — the heart of the normalizer. Also `VersionedTransaction`, `PublicKey`, `AccountInfo`. |
| `@solana/spl-token` | `^0.4.15` | `ACCOUNT_SIZE`, `AccountLayout`, `TOKEN_PROGRAM_ID`. Used to **decode bytes offline**, never to make RPC calls. This is the "fixed layout, no IDL" scope cut. |
| `bs58` | `^6.0.0` | Solana addresses are base58. The provenance check searches for the base58 string inside context chunks, including prefix/suffix matching for truncated addresses. |
| `zod` | `^4.6.5` | Boundary validation: `ActionContext` from the client runtime, hand-written `ToolManifest`s, and the `TaskEnvelope` produced by an LLM. `z.infer` derives the TypeScript type so there is a single source of truth. |

> **`@solana/web3.js` is pinned to `^1.x` on purpose.** The 2.x line is a
> rewrite with an incompatible API (renamed to `@solana/kit`) and has neither
> `Connection` nor `VersionedTransaction`, which is what this project uses. Do
> not upgrade without revisiting the architecture.

### Development dependencies

| Package | Version | Role |
|---|---|---|
| `typescript` | `^7.0.2` | Compiler and type checker. Only runs through `pnpm typecheck` — it is not on the execution path. |
| `vitest` | `^5.0.1` | Test runner. Chosen for running ESM + TypeScript with no configuration and for comparing `bigint` correctly in `expect` — which matters, because every token amount is a `bigint`. |
| `@vitest/coverage-v8` | `^5.0.1` | Coverage through V8's profiler, with no code instrumentation. |
| `tsx` | `^4.23.13` | Runs `.ts` directly, with no build step. See section 5. |
| `@types/node` | `^22.20.3` | Types for `Buffer`, `process`, `node:crypto`. Account decoding is buffer work from end to end. |

### Install scripts that are denied

`pnpm-workspace.yaml` declares which dependencies may run `postinstall`. pnpm
**denies by default** and demands an explicit decision — `postinstall` is the
classic supply-chain attack vector.

| Package | Allowed | Reason |
|---|---|---|
| `esbuild` | **yes** | Its `install.js` places the platform's native binary. Without it, `tsx` and `vitest` do not run. |
| `bigint-buffer` | no | Optional native addon. A correct pure-JS fallback exists. |
| `bufferutil` | no | Optional native WebSocket optimisation. Pure-JS fallback exists. |
| `utf-8-validate` | no | Same. |

A `bigint: Failed to load bindings, pure JS will be used` warning on stderr is
the expected consequence of `bigint-buffer: false`. It is harmless.

---

## 3. Configuration files

| File | What it decides |
|---|---|
| `package.json` | ESM (`"type": "module"`), Node >= 20, pinned package manager, `"private": true` to prevent accidental publication. |
| `tsconfig.json` | Compiler strictness. Every non-obvious option is commented in the file itself. |
| `vitest.config.ts` | `node` environment, `globals: false` (explicit imports), 5s timeout, v8 coverage. |
| `.npmrc` | `engine-strict=true`. |
| `pnpm-workspace.yaml` | Install-script policy (table above). |
| `.gitignore` | `node_modules/`, `.env`, `dist/`, `coverage/`, OS and editor noise. |
| `.env.example` | The contract for environment variables, with no real values. |

### The strict options that matter

`strict: true` turns on eight flags. These are the ones it does **not** turn on
and that were enabled by hand:

- **`noUncheckedIndexedAccess`** — the most important one here. It makes
  `array[0]` have type `T | undefined`. SPL account bytes are read at fixed
  offsets; this flag is what stops an out-of-range `buffer[164]` from silently
  becoming `undefined`.
- **`exactOptionalPropertyTypes`** — `{ delegate?: string }` no longer accepts
  `{ delegate: undefined }`. In the effect model, "field absent" and "field
  present holding nothing" are different things.
- **`noFallthroughCasesInSwitch`** — protects the `switch` over the 8 effect types.
- **`verbatimModuleSyntax`** — forces `import type` for what disappears at build time.
- **`noUnusedLocals` / `noUnusedParameters`** — an error is an error.

### Imports: the `.js` extension is not a mistake

`moduleResolution` is `nodenext`, so TypeScript resolves modules exactly the
way Node does at runtime. The consequence is that relative imports need an
extension, and the extension is `.js` even when the file is `.ts`:

```ts
import type { EffectSet } from "../types/effects.js"; // the file is effects.ts
```

That is the ESM + TypeScript convention. `tsc`, `tsx` and `vitest` all
understand it.

### Why there are no path aliases

`tsc` does **not** rewrite aliases in emitted code — `import "@/types"` would
survive literally into `dist/` and Node would fail to resolve it. Aliases would
require a bundler or an extra runtime loader. With a shallow tree
(`src/normalization/` → `../types/`) the benefit is close to zero.

---

## 4. Repository layout

```
src/
  capture/        # agent wrapper, ActionContext, provenance tagging
  normalization/  # unsigned tx -> EffectSet (simulation + account diff)
  evaluation/     # manifests, provenance, aggregate -> Verdict
  gate/           # allow / flag / deny
  types/          # shared interfaces and Zod schemas
  cli/            # command-line tools over the library
test/
  types/          # mirrors src/types
  normalization/  # mirrors src/normalization
  exploration/    # exploration scripts, not part of the product
  fixtures/       # recorded RPC responses, for offline tests
docs/             # specification (Portuguese) plus pending work and decisions
```

**Test convention:** `test/` mirrors `src/`. A module at
`src/normalization/diff.ts` is tested at `test/normalization/diff.test.ts`.

**Fixture convention:** no network calls inside tests. A real response is
recorded as JSON under `test/fixtures/` and the test reads the file. A test
that runs longer than 5 seconds blows the `testTimeout` — usually a sign that
someone put an RPC call where it does not belong.

---

## 5. Scripts

```bash
pnpm test           # vitest run
pnpm test:watch     # vitest, interactive
pnpm test:coverage  # vitest run --coverage
pnpm typecheck      # tsc --noEmit
```

### `pnpm test` and `pnpm typecheck` are not redundant

`tsx` and `vitest` transpile with **esbuild**, which **strips types without
checking them**. Both will happily run code with type errors. The only thing
that validates types is `tsc --noEmit`.

```
pnpm test       ->  fast, short loop, immediate feedback
pnpm typecheck  ->  quality gate, before a commit and in CI
```

Run both before calling anything done.

### Command-line tools

```bash
# record a fixture from a real devnet simulation
pnpm exec tsx --env-file=.env src/cli/record-fixture.ts --list
pnpm exec tsx --env-file=.env src/cli/record-fixture.ts --all
```

`--env-file` uses Node's **native** env loading — there is no `dotenv` in this
project and there does not need to be. If `.env` is missing, the command fails
loudly, which is the intended behaviour.

### Exploration scripts

Historical artifacts that proved each capability against real responses. They
are not part of the product.

```bash
pnpm exec tsx --env-file=.env test/exploration/read-account.ts <address>
pnpm exec tsx --env-file=.env test/exploration/inspect-transaction.ts <signature>
```

---

## 6. What to fill in `.env`

```bash
cp .env.example .env
```

| Variable | Required | Where to get it |
|---|---|---|
| `VETO_RPC_URL` | yes | [dashboard.helius.dev](https://dashboard.helius.dev) → free account → **Endpoints** → copy the **mainnet** URL |
| `VETO_RPC_URL_DEVNET` | yes | Same panel, devnet endpoint. Used by the fixture recorder. |
| `VETO_RPC_COMMITMENT` | no | Leave it at `confirmed`. `processed` is faster and less stable; `finalized` is too slow for an agent's decision loop. |

**Why Helius and not the public RPC.** `api.mainnet-beta.solana.com` rate-limits
aggressively and does not guarantee `innerInstructions` or the `accounts`
return on simulation — the two fields the normalizer depends on. The free
Helius tier covers the whole proof of concept.

**Why the whole URL is the secret.** The api-key sits in the query string. It
is not "the key is secret and the URL is not" — the URL *is* the key. That is
why `.env` is gitignored and why every module redacts it before printing an
error.

---

## 7. How to verify everything works

From a clean checkout:

```bash
pnpm install
pnpm typecheck
pnpm test
```

Expected:

```
$ pnpm typecheck
(no output, exit code 0)

$ pnpm test
 Test Files  7 passed (7)
      Tests  63 passed (63)
```

### Checking that strictness is really on

Strict configuration that produces no error is not on. Create a throwaway file:

```ts
// test/__tmp.ts
const bytes: number[] = [1, 2, 3];
const b: number = bytes[164];              // must fail
type Target = { delegate?: string };
const a: Target = { delegate: undefined }; // must fail
export { b, a };
```

`pnpm typecheck` must report **two** errors — `TS2322` and `TS2375`. If it
passes cleanly, `tsconfig.json` is not being read. Delete the file afterwards.

---

## 8. Not configured yet, on purpose

| Item | Why it is out |
|---|---|
| `build` script | Nothing consumes `dist/` yet. When it does: a `tsconfig.build.json` with `outDir`, no `noEmit`, and only `src/` in `include`. |
| Linter / formatter | None requested. Strict `tsc` already catches the class of error that matters. |
| Postgres + Drizzle | Only the aggregate check needs persistence, and that is a later stage. |
| CI | When it lands: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`. |
