# Risk decisions

*Kept during construction, not written afterwards.*

Three kinds of entry:

- **numbered (1, 2, 3…)** — decisions taken while building. Every one is
  reversible; they are listed here so they can be disagreed with.
- **A1, A2…** — open attention points with **no defence implemented**. Known
  holes, each with the proposed defence recorded.
- **REJECTED** — ideas discarded with the reason, so the same discussion is not
  reopened months later without remembering why.

Implementation gaps per block live in `pending.md`.

---

## Environment

1. `engines: node >=20` even though Node 20 reached end of life in April 2026.
2. No path aliases. `tsc` does not rewrite aliases on emit; the cost is a `.js`
   extension on relative imports.
3. `@solana/web3.js` pinned to `^1.x`. The 2.x line (renamed `@solana/kit`) has
   neither `Connection` nor `VersionedTransaction`.
4. `typescript@7` (the Go port, a brand-new major) resolved by pnpm. Tested
   against the full strict tsconfig.
5. `allowBuilds`: install scripts denied for `bigint-buffer`, `bufferutil` and
   `utf-8-validate`; pure-JS fallbacks are used. Only `esbuild` is allowed.

## Types — `effects.ts`

6. `EffectSet` is **flat**, against the category-grouped shape in
   `veto-construcao.md`. Category views became derived functions.
7. Three fields added beyond the spec: `slot`, `coverage`, `simulation`. They
   come from what the exploration scripts found.
8. `SimulationOutcome` is a discriminated union — it forces "failed" and
   "unavailable" to be handled differently.
9. `AuthorityKind` added to `Effect` (absent from the spec's flat shape).
10. Zod is the single source for enums; the TypeScript type derives via
    `z.infer`. Avoids `as const` and two lists that could drift.
11. `Effect` carries no Zod validation (it is built internally). Zod guards
    boundaries only.
12. Everything is `readonly`.

## Types — `context.ts`

13. The `semi` trust level is **not** enough to explain where an address came
    from; only `trusted` counts. That is calibration, not logic.
14. Source matching is by **substring**. Real weakness:
    `malicious.xyz/?ref=quote-api.jup.ag` would match as trusted. Documented in
    the code; harden to hostname matching in the provenance detector.
15. `ActionContext.unsignedTx` takes a `VersionedTransaction` object, not a wire
    format (base64).
16. `taskId` is optional — a task envelope may not exist yet.

## Types — `manifest.ts`

17. A manifest declares its own `args` (name → type). Every `ArgRef` must point
    at a declared argument. Not in the spec; invented so a typo fails at load
    time rather than in production.
18. A `unit` field (`raw` | `decimal`) is required whenever `maxAmount` or
    `minAmount` comes from an argument. Without it, 10 (USDC) would be compared
    against 10000000 raw — a false positive on every transfer.
19. `version` on the manifest, to compose `policyVersion`.
20. `validateReferences` also reports an effect that is in `must` and `mustNot`
    at the same time.
21. A malformed `arg:` is treated as a literal string (an address), not as an
    error. That is the contract of the prefix.
22. `MAX_TOLERANCE = 0.10` caps the slack a manifest may declare.

## Types — `verdict.ts`

23. `CheckKind` gained three values beyond the spec's four: `content` (the
    classifier), `envelope`, and `coverage` (degradation).
24. `Finding` gained a `rule` field (stable rule identifier). Not in the spec.
25. `decide()` does **not** live in types — the severity-ceiling rule belongs to
    the evaluation layer.
26. `DEFAULT_THRESHOLDS = { highsForDeny: 2, mediumsForFlag: 1 }`, per the spec,
    but configurable per customer.

## Block 2 — `rpc.ts`

27. The normalizer depends on the `RpcClient` **interface**, never on
    `Connection`. In tests a fake implementation serves a fixture. That is what
    makes the diff testable without a network.
28. The `number → bigint` boundary lives **only** here. Above 2^53-1,
    `lamportsExact: false` instead of pretending precision survived.
29. `RpcResult` is a discriminated union; a failure is never an exception. It
    feeds the `unavailable` status of the `EffectSet`.
30. `readLookupTables` runs in **parallel**. Resolving lookup tables is the
    extra call on the critical path, because `meta.loadedAddresses` only exists
    after execution.
31. No `as const` in the simulation config; it uses the SDK's
    `SimulateTransactionConfig` type instead.
32. **Verified against the network:** lookup table `Hu5cMUbi…` index 111 →
    `44X92BsHwLxr…`, the same account a real transaction only exposed through
    `meta.loadedAddresses`. Resolving lookup tables before signing works.

## Block 2 — `fixture.ts` and the recorder

33. bigint is serialized as a **decimal string**, bytes as base64. The schema
    refuses `lamports` recorded as a number.
34. The fake client tells "recorded, and the account does not exist" (null)
    apart from "never recorded" (failure). It indexes by the **requested**
    addresses, not by the recorded values.
35. Fixtures are recorded on **devnet** and built by us, not captured from
    historical mainnet transactions. Simulating a historical mainnet
    transaction today would fail, because the state has moved. The cost is
    realism: no lookup tables, no real swap.
36. The `unlimited-approve` scenario uses `createApprove` with an owner that
    does not sign — `sigVerify: false` allows it. The fixture contains a real
    `delegatedAmount = u64::MAX`, verified in the bytes.
37. The fee payer for every fixture is the public devnet account
    `11111111111111111111111111111112`. If its balance changes, re-recording
    changes the numbers the tests assert.

## Project language

38. The repository is in **English**: code, identifiers, comments, tests,
    fixture keys, `README.md`, `SETUP.md`, `pending.md` and this file. The three
    specification documents in `docs/` stay in Portuguese as internal design
    notes.
39. Two exploration scripts were **deleted** rather than translated:
    `simular-transferencia.ts`, superseded by the fixture recorder, and
    `inspecionar-inner-instructions.ts`, which the normalizer will absorb. Their
    findings are recorded in `README.md` and here; the git history keeps the
    code.

## Product and policy decisions (settled with the project owner)

40. **Degradation is fail-open with a loud alert.** When VETO cannot evaluate —
    RPC down, rate limited, timeout — the transaction is allowed, a critical
    `coverage` finding is recorded and the customer is alerted immediately.
    Fail-closed would turn an outage of ours into an outage of the customer's
    operation, which is a denial of service caused by the defence itself.
    Configurable per customer; this is the default.
41. **Timeouts: 1.5s per RPC call, 3s total**, after which the outcome degrades
    to `unavailable`. Provisional until 2.7 measures the real distribution.
42. **Only writable accounts are requested for post-state.** A readonly account
    cannot change state, so it needs no post-state. This cuts a DeFi
    transaction from ~256 referenced accounts to a few dozen. Caveat recorded:
    the message's writable flag can be demoted by the runtime, so it is treated
    as an upper bound, never a lower one.
43. **Nothing is filtered as noise.** Every state change becomes an effect;
    fees, rent and duplicated wrapped SOL get explicit attribution instead of
    being dropped by size. A size filter is exactly the blind spot salami
    slicing exploits.
44. **`policyVersion` is a hash of the effective policy bundle** with a readable
    prefix (`p1-a3f9c2`): manifests, thresholds and customer configuration. It
    changes on its own when any part changes — nobody has to remember to bump a
    number, which is where manual versioning always breaks.
45. **Tolerance above the cap requires `toleranceOverride: { value, reason }`.**
    The normal path stays capped at 10%; exceeding it requires writing down why,
    and the reason is versioned with the manifest and visible in review.
46. **The CLI stays on `tsx`.** No `bin` entry, no build step, until somebody
    outside the project wants to install it.
47. **Only `veto-construcao.md` gets translated** of the three specification
    documents. It is the architecture one, the one a technical reviewer would
    open. The other two stay in Portuguese.
48. **Check B compares the SUM of what a pattern matched, not each effect.**
    Judging each effect on its own let a transaction split a drain across two
    accounts of the same mint: declared 100, two decreases of 100 each, both
    under the ceiling, nothing fires. The declared amount bounds the
    operation, not each of its legs.
49. **`accountScope` is enforced, and only against effects the manifest
    ALREADY permits.** `may` patterns have to be loose enough to cover the
    mechanical noise of a real transaction, which makes them loose enough to
    cover the same effect on an account nobody named. An effect no pattern
    matched is already reported as undeclared, with its account, so checking
    it here too would take two findings off one event -- enough on its own to
    reach the deny threshold.
50. **"Derived" means provably related to an argument**, by ATA derivation or
    by the token account's own `owner` bytes. A third-party program's PDA is
    not derivable, because the seeds live in that program's source. A tool
    that genuinely routes through accounts nobody can enumerate has to
    declare `open` and mean it, rather than claim a scope the code would have
    to fail open on.
51. **Scope reports only losses.** DELEGATE_GRANT, AUTHORITY_CHANGE,
    OWNER_CHANGE, ACCOUNT_CLOSE, BALANCE_DECREASE. An account that gains value
    or comes into existence outside the scope is not a loss to anyone, and
    provenance already asks who the beneficiary is; reporting it here as well
    would put a finding on every swap.
52. **The fee payer is inside every tool's scope.** Every transaction charges
    its payer, so excluding it would report the fee as an out-of-scope loss on
    every single call.
53. **A manifest is not compared when nothing executed.** On a failed or
    unavailable simulation there are no effects, so every `must` pattern is
    trivially unmatched -- two of those reach DENY on a transaction that would
    have failed anyway, with a reason that is true and says nothing. Coverage
    already carries the fact, at the severity it deserves.
54. **`Effect.owner` is not `counterparty`.** A counterparty receives, and
    provenance exists to ask where it came from; the owner of an account that
    LOSES value receives nothing, and filing it as a counterparty would ask
    the captured context to explain the victim.
55. **An effect pattern can constrain by `owner`.** Without it "the sender's
    balance goes down" can only be written as "SOME account of this mint goes
    down", which also matches a liquidity pool halfway through a route. Since
    check B sums what a pattern matched, the route's volume was being added to
    the user's spend.
56. **`swap` declares `accountScope: "open"` and permits the route's balance
    decreases.** Measured on real mainnet traffic: without it every legitimate
    swap produced findings, because a swap takes tokens out of pools by
    definition. A swap routes through program-derived accounts whose seeds
    live in those programs' source, so no account scope there could be
    enforced -- claiming one would be a rule that quietly fails open. What
    bounds a swap is `mustNot`, the summed magnitude of what the CALLER
    spends, and who receives the output.
57. **False positives are measured against an honest declaration derived from
    the transaction's own effects** (`cli/sample-evaluate.ts`). Real
    transactions carry no tool call, no goal and no manifest, so they cannot
    be evaluated as they stand. Building the declaration a truthful agent
    would have made means nothing sampled is an attack, so every finding is a
    false positive by construction. It is a LOWER BOUND, deliberately: the
    checks are handed the friendliest possible input, so anything that fires
    there fires on the easy case.
58. **The same run measures detection, by declaring dishonestly.** A sample
    where everything is allowed proves nothing on its own -- it could equally
    mean the checks are dead. Each transaction is re-evaluated with half the
    amount declared, and with a goal that names nobody.
59. **The sampler's classifier refuses to guess.** A first version labelled
    any transaction that closed an account `close_account`, and the tally
    filled with correct readings of a wrong label. A twenty-one-effect
    arbitrage bundle is not a close, and no manifest should be asked to
    pretend it is.
60. **Token-2022 extensions are reported by NAME, from an allowlist of the
    harmless ones** (`coverage.token_extensions`, medium). The base layout
    decodes correctly, which is why the decoder accepts the longer buffer --
    but a transfer hook runs an arbitrary program on every movement and a
    permanent delegate lets a third party move the tokens forever, and
    neither would ever become an effect. A first version reported any account
    with extension bytes at all, and measured on real traffic that flagged
    every legitimate transfer of a Token-2022 token. Only the TYPE ids are
    read, never the values: enough to answer "could this move the tokens
    without showing up as an effect", and a few lines of offset arithmetic
    rather than a second decoder.
60a. **An extension id this code does not know is opaque, not harmless.** New
    types get added to the program over time, and assuming an unknown one is
    benign is precisely how a detector goes quiet on the thing it was built
    for. So the list is an allowlist of the harmless, never a blocklist of
    the dangerous.
61. **The sampling CLIs treat a rate limit as an answer, not an exception.** A
    429 does not reply in JSON -- it replies `Too Many Requests` in plain text
    -- and parsing that threw an unhandled rejection that took a whole
    sampling run down mid-flight. The library never had this hole; the CLI
    did, and sampling is exactly the workload that hits a rate limit.

---

## Open attention points — no defence implemented

**A1. Customer configuration has no validation.** It is the only place where a
mistake *switches off a whole detector without saying so* — an over-broad
`SourceTrust` pattern silently disables the provenance check. Proposed defence:
a schema requiring a full hostname, plus a **preview** showing what the pattern
would match against a sample of the customer's real traffic.

**A2. The seam between a manifest and the customer's real tool.** Both sides can
be internally correct and still fail to line up: the manifest says `arg:from`
while the tool takes `source`. Nobody typed anything wrong. Defence: an
unresolved reference must become a `coverage` finding, never silence.

**A3. Always-critical effects are not implemented.** `AUTHORITY_CHANGE`,
`OWNER_CHANGE` and unlimited `DELEGATE_GRANT` should be refused regardless of
what a manifest says. They are the safety net under an incomplete `mustNot`.

**A4. `MAX_TOLERANCE = 0.10` is an invented number.** Partially resolved: the
cap exists and is tested, but the value was chosen with no data. It needs real
traffic: what is the p99 slippage of a legitimate swap in a volatile market? Too
low means false positives; too high means a skim fits inside the slack — nobody
steals 500, they steal 3% of every operation, and only the aggregate check would
see it. Still missing: a severity of its own for extreme slippage, and an
explicit exception for tools that legitimately need more slack.

**A5. Allowlisted addresses are never checked on-chain.** A mistyped address
almost never exists, which makes it detectable at input time.

---

## Rejected

**An LLM that rewrites the user's goal at runtime.** Provenance is a string
search over the text the user actually wrote. Rewriting it allows an address to
be **introduced** carrying `user` provenance — which is trusted — that the user
never typed, laundering an attacker's address into the trusted tier. It can also
drop a legitimate address, turning it into a critical false positive. The user's
text is forensic evidence, and evidence is not edited.

**Accepted with constraints:** an LLM as an **authoring assistant** for
configuration at onboarding. It suggests, never applies. The diff is visible, a
human confirms, and the configuration remains a static versioned artifact. Same
reconciliation as the content classifier and the task envelope.

**The premise "the customer's prompt cannot be injected" is false in general.**
A user can paste third-party content into their own prompt. `user` is trusted by
convention, and that convention only holds if nobody edits the text.
