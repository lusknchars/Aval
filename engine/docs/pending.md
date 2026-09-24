# Pending work, by block

*Tracked during construction, not written afterwards.*

Urgency: **B** blocks the next piece · **P** the product is not complete
without it · **D** known debt, can wait.

---

## Block 1 — Types (`src/types/`) — *built*

What exists: the closed vocabulary of 8 effects, `EffectSet`, `ActionContext`
with provenance, `ToolManifest` with reference validation, `Verdict`.

| # | Item | Urgency |
|---|---|---|
| 1.1 | **Always-critical effect set** (`AUTHORITY_CHANGE`, `OWNER_CHANGE`, unlimited `DELEGATE_GRANT`). The safety net under an incomplete `mustNot`, and the only check that works with no manifest at all. Does not exist. | **P** |
| 1.2 | **`ArgRef` resolver** — resolve `arg:from` against the tool call arguments, failing explicitly. Static validation exists; runtime resolution does not. | **B** |
| 1.3 | **Combination rule (`decide`)** — severity ceiling → `allow`/`flag`/`deny`. Types and thresholds exist; the function belongs to the evaluation layer. | **P** |
| 1.4 | ~~bigint serialization~~ — **resolved in block 2**: decimal strings in fixtures. | done |
| 1.5 | **`policyVersion` composition** — today it is a free string. It must be derived from manifest versions + thresholds + classifier version. | **D** |
| 1.6 | `MAX_TOLERANCE = 0.10` is arbitrary calibration, chosen with no data. Measure the p99 slippage of a legitimate swap. | **D** |
| 1.7 | A severity of its own for **extreme slippage** — the spec asks for it; today tolerance is binary (inside passes, outside is a finding). | **D** |
| 1.8 | An explicit exception for a tool that legitimately needs more slack than the cap. | **D** |

---

## Block 2 — RPC and fixtures (`src/normalization/`) — *built*

What exists: `rpc.ts` with the `RpcClient` interface and a web3.js-backed
implementation; `fixture.ts` with the recorded format and a fake client;
`src/cli/record-fixture.ts`; three recorded fixtures.

| # | Item | Urgency |
|---|---|---|
| 2.1 | ~~Fixture recorder~~ | done |
| 2.2 | ~~Minimum fixtures~~ — `transfer-sol`, `create-ata`, `unlimited-approve` recorded. | done |
| 2.3 | ~~Fake `RpcClient`~~ | done |
| 2.4 | **`lamportsExact` is consumed by nobody.** When an effect is computed from an inexact value it must become a `coverage` finding. Today it disappears. | **P** |
| 2.5 | ~~Partial failure in `readLookupTables`~~ — resolved: unreadable tables are named in `unresolvedTables`. Former text: **partial failure** — the first error currently brings down the whole read. Resolving what it can and flagging incomplete coverage is probably right. | **P** |
| 2.6 | **Timeout and retry policy** — does not exist. It must be explicit: how long before degrading to `unavailable`. | **P** |
| 2.7 | **Latency budget unmeasured.** Resolving lookup tables is an extra round trip; the target is deciding under 100 ms. No measurement has been taken. | **P** |
| 2.8 | `identifyNetwork` exists but is never called automatically. Decide whether it is mandatory at client construction. | **D** |
| 2.9 | Behaviour under **rate limiting** (429): today `disableRetryOnRateLimit: true` surfaces the error. What the gate does then is undecided. | **P** |
| 2.11 | **The baseline and the simulation can disagree.** Mitigated, not solved: the read and the simulation are fired in parallel and retried until both report the same slot, which fixed the arithmetic in 4 of 5 runs against a busy mainnet account. The fifth still showed a movement that was not this transaction's, so identical slot numbers do not guarantee an identical view. Declared through `EffectSet.baselineSlot` and a CLI warning. Option not yet taken: sample twice and require the effects to match, at the cost of doubling the RPC calls. Former text: **different slots.** There is no way to read account state and simulate atomically over public RPC, so anything that changes an observed account in between is attributed to this transaction. Observed on mainnet: a busy destination account gained lamports from unrelated transfers inside a one-slot gap. Declared through `EffectSet.baselineSlot` and a CLI warning, but not solved. Options to evaluate: simulate first and read the baseline at the simulation's slot; retry when the slots disagree; or accept the gap for accounts with low churn, which is the agent's own case. | **P** |
| 2.10 | ~~No fixture uses an Address Lookup Table~~ — resolved differently: lookup tables are built offline in the tests, so no recorded mainnet fixture is needed. Former text: **no fixture uses a lookup table.** Fixtures are built by us on devnet; a historical mainnet transaction cannot be simulated today because state has moved. `contas`/`accounts` resolution will need a different fixture shape: message and table contents, with no post-state. | **B** |

---

## Block 3 — SPL decoding (`spl.ts`) — *built*

Read `amount`, `owner`, `delegate`, `delegatedAmount`, `state` and
`closeAuthority` from the bytes, at fixed offsets, with no IDL.

| # | Item | Urgency |
|---|---|---|
| 3.1 | ~~Token-2022~~ — base fields decode; `hasExtensions` is exposed so the caller records incomplete coverage. Former text: **not covered.** Same base layout, but extensions change the account size. Decision: cover the classic Token Program only and record Token-2022 as "not covered" in `coverage`. | **P** |
| 3.2 | **Stake and vote out of scope.** `AUTHORITY_CHANGE` includes stake authorities and program upgrade authority; none will be read at first. Mark as not covered. | **P** |
| 3.3 | ~~Mint `decimals`~~ — `decodeMint` reads them. Caching is still open. Former text: **mint decimals** — needed for the manifest's `decimal` unit. It requires reading the mint account, which is another round trip. Cache? | **B** |
| 3.4 | ~~Closed account vs unobserved~~ — resolved in the diff. Former text: a **closed** token account comes back as `null` in the post-state. Tell that apart from "not observed". | **B** |

---

## Block 4 — Account resolution (`accounts.ts`) — *built*

| # | Item | Urgency |
|---|---|---|
| 4.1 | ~~Resolve lookup tables before signing~~ — done. Former text: **resolve lookup tables** — verified to work (table `Hu5cMUbi…` index 111 returns the same account the executed transaction showed). Implementation missing. | **B** |
| 4.2 | ~~Build the observation list~~ — done: writable accounts only. Former text: **build the list.** This is what defines coverage: anything not requested never shows up in the simulation. | **B** |
| 4.3 | **`args_plus_derived` scope** — requires deriving PDAs and ATAs from the arguments. Without it the manifest's account scope is not verifiable. | **P** |
| 4.4 | **Writable demotion** — the message declares writable; the runtime may demote. The message flag is not absolute truth. | **D** |
| 4.5 | ~~Account cap~~ — resolved by observing only writable accounts. Former text: **account cap.** A transaction can reference ~256 accounts with lookup tables. Asking for all of them costs; asking for fewer creates a blind spot. Decide the limit and what happens past it. | **P** |

---

## Block 5 — Diff (`diff.ts`) — *built*

| # | Item | Urgency |
|---|---|---|
| 5.1 | ~~Wrapped SOL counted twice~~ — resolved: a token account reports its token side only. Former text: **counted twice.** Observed in a real swap: the lamport delta and the token delta on the same account are identical. Needs an explicit rule. | **B** |
| 5.2 | ~~Fee attribution~~ — resolved: the fee leaves the payer's delta and is carried on `EffectSet.fee`. Former text: **fee and rent.** The post-state already deducts the fee from the fee payer (verified). That must not become a `BALANCE_DECREASE` attributed to the user's intent. | **B** |
| 5.3 | ~~Detect create and close~~ — done. Former text: **detect create/close** from `null → exists` and `exists → null` transitions. Depends on 3.4. | **B** |
| 5.4 | ~~PROGRAM_INVOKE from innerInstructions~~ — done, both response shapes narrowed at runtime. Former text: **two shapes** — two possible shapes in the response (`jsonParsed` and compiled). The installed SDK only validates the first. | **P** |
| 5.5 | ~~Noise threshold~~ — settled: nothing is filtered by size. Former text: **noise threshold.** Not every lamport change is a meaningful effect. Define what counts as noise without creating a blind spot. | **P** |
| 5.6 | **Unlimited allowance** — `delegatedAmount == u64::MAX` must become a signal of its own, not just another `DELEGATE_GRANT`. | **P** |

---

## Block 6 — Orchestration (`normalize.ts`) — *built*

| # | Item | Urgency |
|---|---|---|
| 6.1 | ~~Assemble the EffectSet~~ — done. Former text: assemble: effects + `slot` + `simulation` + `coverage`. | **B** |
| 6.2 | ~~Explicit degradation~~ — done, with tests for each path. Former text: **explicit degradation**: RPC down, simulation refused, incomplete coverage — each with its own path, none collapsing into an empty effect list. | **B** |
| 6.3 | ~~minContextSlot~~ — applied between the read and the simulation. Former text: `minContextSlot` between the before-read and the simulation. Decide whether it is mandatory. | **D** |

---

## Block 7 — CLI (`src/cli/`) — *built*

| # | Item | Urgency |
|---|---|---|
| 7.1 | ~~`inspect`~~ — done. Former text: **inspect** — take a mainnet signature or a base64 transaction and print a readable `EffectSet`. | **P** |
| 7.2 | ~~`record-fixture`~~ | done |
| 7.3 | ~~JSON output~~ — done, amounts as decimal strings. Former text: **JSON output** (`--json`) for research scripts. | **P** |
| 7.4 | ~~Never print secrets~~ — inherited from the RPC module, verified. Former text: **never print.** Handled in the RPC module; the CLI must inherit the discipline. | **P** |
| 7.5 | ~~Distinct exit codes~~ — done: 0 pass, 1 input, 3 unavailable, 4 would fail. Former text: distinct exit codes, like the exploration scripts. | **D** |
| 7.6 | Decide whether this becomes a publishable binary (`bin` in `package.json`) or stays on `tsx`. | **D** |

---

## Cross-cutting

| # | Item | Urgency |
|---|---|---|
| T.1 | **Customer configuration has no validation at all.** It is the only place where a mistake *switches off a whole detector without saying so* (an over-broad `SourceTrust` pattern). Defence: require a full hostname, plus a **preview** of what the pattern would match against real traffic. | **P** |
| T.2 | **The seam between a manifest and the customer's real tool.** Nobody types anything wrong and it still fails to line up. An unresolved reference must become a `coverage` finding. | **P** |
| T.3 | **Allowlisted addresses are never checked on-chain.** A mistyped address almost never exists — that is detectable at input time. | **D** |
| T.4 | **No performance measurement anywhere.** | **P** |
| T.5 | **No CI.** `pnpm typecheck && pnpm test` should run on every push. | **D** |
| T.6 | The three specification documents in `docs/` are in Portuguese; everything else is in English. Decide whether to translate them. | **D** |
