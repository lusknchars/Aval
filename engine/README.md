# VETO

**Behavioral detection for autonomous AI agents that operate wallets on Solana.**

Wallet policy engines are firewalls: they approve anything inside the limits.
VETO is the EDR. It catches the transaction that breaks no rule but was never
what the user asked for.

---

## The problem

Agents now hold keys and move real money. The controls that exist today are
static policies: a spending cap, an allowlist of programs, a list of approved
destinations.

None of them can answer the question that matters: **is this what the user
actually asked for?**

An agent reads a web page with injected instructions and emits a transfer to an
attacker. That transaction is under the cap, calls an approved program and is
fully authorized. It passes every policy check. What changed was not the amount
or the program — it was *who was really asking*.

| Incident | Date | Loss |
|---|---|---|
| Step Finance | Jan 2026 | 261k SOL · ~US$27–30M · company shut down |
| OpenClaw | Feb 2026 | ~US$250k |
| Freysa | — | ~US$47k |

The common pattern: **no policy was violated.**

The failure is not limited to attacks. Hallucination, tool misuse, faulty
reasoning, model drift, misconfiguration and corrupted upstream data produce the
same class of incoherent-but-authorized transaction — and they are far more
frequent than a targeted attack.

### Why the existing layer cannot fix this

| Layer | Question it answers | Who occupies it |
|---|---|---|
| Key | Where the key lives, who signs | Turnkey, Privy, Fireblocks, Crossmint, Squads |
| Policy | What is permitted | DCP, the policy engines inside Turnkey and Privy |
| **Coherence** | **Does this make sense given the request and the history** | **Empty — VETO** |

Two structural gaps in the policy layer:

1. **It never sees the user's request.** It cannot distinguish an authorized
   action from a requested one.
2. **It evaluates one transaction in isolation**, while the attack is a
   sequence. A hundred transfers of 499 under a 500 cap all pass.

The strongest evidence is in the incumbents' own documentation. Turnkey and
Privy already expose third-party approval hooks — `consensus`, key quorum — so
they expect an external approver to exist. But every condition those engines
offer is a property of the isolated transaction: address, asset, amount, chain,
timestamp. That list is objective proof that the coherence layer is missing.

---

## How it works

VETO integrates with the client's agent runtime at two points: it captures
context as it enters the model, and it evaluates the transaction before the
wallet signs it.

```
  authorized request
        │
        ▼
  client's AI agent
        │
        ├── context, with provenance per chunk ──────┐
        ├── tool call ───────────────────────────────┤
        │                                            │
        └── unsigned transaction                     │
                    │                                │
                    ▼                                │
          simulateTransaction (RPC)                  │
                    │                                │
                    ▼                                │
              EffectSet  ─────────────────────────►  │
                                                     ▼
                                      ┌──────────────────────────┐
                                      │   DETERMINISTIC LAYER    │
                                      │  manifests · provenance  │
                                      │  magnitude · aggregate   │
                                      └────────────┬─────────────┘
                                                   │ Verdict
                                                   ▼
                                         allow · flag · deny
                                                   │
                                                   ▼
                                            signature gate
```

### The core idea: there are three levels, not two

Comparing a sentence to a state diff looks like it requires semantic
interpretation — which is slow, expensive and full of false positives. It does
not, because a third object sits between them and is already structured:

```
LEVEL 1 — user goal            natural language, AMBIGUOUS
  "swap 10 USDC for SOL"
          ↓
LEVEL 2 — tool call            STRUCTURED
  swap({ from: "USDC", to: "SOL", amount: 10 })
          ↓
LEVEL 3 — simulated effect     STRUCTURED
  { BALANCE_DECREASE…, DELEGATE_GRANT… }
```

The agent already performed the language-to-structure translation: it emitted a
function call with named arguments. Comparing level 2 to level 3 therefore needs
**no semantics at all** — it is set difference and membership.

Only the 1↔2 link is fuzzy, and it is handled separately, once per task, by
deriving a structured task envelope.

### Closed vocabulary — eight effect types

```
BALANCE_DECREASE   BALANCE_INCREASE   DELEGATE_GRANT    AUTHORITY_CHANGE
OWNER_CHANGE       ACCOUNT_CREATE     ACCOUNT_CLOSE     PROGRAM_INVOKE
```

**Closed**, so "what the transaction did" and "what the tool is allowed to do"
become two sets of the same type. No room for interpretation, therefore no false
positives from ambiguity.

**Small**, because eight types cover nearly all possible harm on Solana: losing
value, giving up authority, losing the account.

**Program-agnostic**, because the types derive from the account model, not from
instructions. A program VETO has never seen, if it grants a delegate, produces
`DELEGATE_GRANT` all the same. This is what makes the project tractable: a
universal IDL-based instruction decoder would never be finished.

### The five checks

| Check | Question | Catches |
|---|---|---|
| **A · Undeclared effect** | Does the transaction do anything the tool manifest does not allow? | A delegate granted during a swap |
| **B · Magnitude** | Does the amount match what the tool call declared? | Declared 10, moved 500 |
| **C · Provenance** | Where did this counterparty address come from? | Indirect prompt injection |
| **D · Aggregate** | What has happened across a time window? | A hundred transfers of 499 under a 500 cap |
| **E · Content classification** | Does this context chunk carry the *shape* of an injected instruction? | Poisoned retrieval, poisoned memory, jailbreak framing |

**Provenance is the highest-value check and the cheapest to build.** Consider the
most common injection: the agent reads a poisoned page and emits
`transfer({ to: "7xKX…", amount: 500 })`. Check A passes perfectly — the
transaction does exactly what the tool call said. The corruption is not in the
execution, it is **in the origin of the argument**. Provenance is the only check
that sees it.

For every counterparty that receives value or authority:

| Origin | Verdict |
|---|---|
| Named in the user's goal | legitimate |
| In the configured allowlist | legitimate |
| Output of a trusted tool source | probable |
| Seen in prior history with this agent | attention |
| Only in a `retrieved` / `memory` / untrusted `tool_output` chunk | **critical** |
| Does not appear anywhere in the context | **critical** |

Absence is a signal, not silence. An address that appears nowhere was produced
somewhere VETO does not observe.

### Check E — content classification at ingestion

Checks A through D operate on structure: effects, amounts, addresses, windows.
They are blind to one thing — text that was written to manipulate the agent but
has not yet produced a counterparty address VETO can trace. That is the gap a
dedicated classifier closes.

A small, purpose-trained classifier scores every chunk as it enters the agent's
context, tagging it with an injection probability alongside its provenance. It
runs at **ingestion time**, not at signing time, so it is outside the latency
budget of the decision loop.

**Candidate models** — final choice pending benchmarking on our own corpus:

| Model | Size | Notes |
|---|---|---|
| Meta · Llama Prompt Guard 2 | 86M | Trained specifically for prompt injection and jailbreak detection; runs on CPU in single-digit milliseconds |
| ProtectAI · `deberta-v3-base-prompt-injection-v2` | ~184M | Encoder classifier, permissive license |
| Google · ShieldGemma | 2B+ | Broader safety coverage, too large for per-chunk ingestion scoring |

The 86M class is the target: small enough to run locally on every chunk with no
external API call, no data leaving the customer's environment, and no per-token
cost.

#### Why this does not violate "no LLM in the decision path"

Three distinctions matter, and they are deliberate:

1. **A classifier is not a generator.** Frozen weights, a fixed threshold and no
   sampling make it a pure function: the same chunk always produces the same
   score. Pinning the model version keeps it auditable — the score and the model
   hash are recorded in the finding, exactly like `policyVersion`.
2. **It never decides.** It emits a `Finding` with a severity, and the same
   severity-ceiling rule produces the verdict. It cannot release a transaction
   and cannot reverse a block.
3. **It does not judge whether content is true.** It judges whether content has
   the *shape of an instruction* — imperative framing, role override, exfiltration
   patterns. VETO still never evaluates the truthfulness of anything.

#### How E composes with C

The two are complementary, and the combination is stronger than either alone:

| Provenance (C) | Classifier (E) | Reading |
|---|---|---|
| Address only in a `retrieved` chunk | that chunk scored clean | Suspicious — could be a legitimate routing address |
| Address only in a `retrieved` chunk | that chunk scored as injection | **The attack, named at both ends** |
| All addresses accounted for | a `memory` chunk scored as injection | Poisoning staged for a future action — flag now, before any transfer |

The third row is what makes E worth building: it detects poisoning **before** a
transaction exists, which is the only point where nothing has been lost yet.

#### Memory poisoning

The same classifier is applied to what the agent *writes* to its own memory, not
only to what it reads. An agent persisting a memory entry that carries the shape
of an instruction is the signature of a staged attack. Detection here is cheap
because the write path is narrow, and the remediation — quarantining that entry —
is one of the few actions in this system that genuinely undoes something.

### From findings to a verdict

No weighted score. A numeric score is impossible to explain to an auditor and
impossible to calibrate. The rule is a severity ceiling:

```
any critical finding        → DENY
two or more high findings   → DENY
one high finding            → FLAG
only medium or low          → FLAG above threshold, otherwise ALLOW
no findings                 → ALLOW
```

Every decision traces back to a named finding and a specific rule. Each verdict
records the `policyVersion` in force, so months later it is possible to show
exactly which rules applied at the time of an incident.

### Where a language model is allowed — and where it is not

**The decision path contains no LLM.** Two reasons: latency inside the agent
loop, and auditability in front of a compliance auditor.

A model is used in exactly three places, none of which decides anything:

- **Content classification at ingestion** — a frozen small classifier scoring
  context chunks, as described above. Deterministic by construction and off the
  signing path.

- **Task envelope derivation** — once per task, outside the loop, converting the
  user's goal into a structured object (allowed tools, value ceiling, named
  counterparties, expiry). Every subsequent action is checked against that object
  by field comparison, in microseconds. The envelope is persisted with the model
  and timestamp, so it is auditable.
- **Alert explanation** — after the decision, turning structured findings into a
  readable sentence.

A later "AI as a judge" stage is planned for semantically ambiguous cases. It
will run in observation mode and will never be able to release a transaction or
reverse a block.

### Degrade, never open

A tool with no manifest disables checks A and B. **C and D keep working**, plus a
minimum set of always-critical effects that are never acceptable without an
explicit manifest authorizing them: `AUTHORITY_CHANGE`, `OWNER_CHANGE`, and
`DELEGATE_GRANT` with unlimited allowance.

Missing information never becomes an ALLOW.

---

## Why Solana

- Deterministic simulation that is cheap and fast enough to fit inside an agent's
  decision loop
- Transaction density that makes the economics work
- It is where the reference incidents happened
- Lighthouse already exists in production for on-chain post-state assertion, so
  no custody program has to be written

---

## Project status

**Pre-product. Exploration phase.** `src/` is intentionally empty.

The work so far has been to verify, against real mainnet and devnet responses,
that every input the normalizer needs is actually obtainable. Four exploration
scripts live in `test/exploration/`. None of them signs, sends or persists
anything.

| Script | What it proves | Observed |
|---|---|---|
| `read-account.ts` | Account state is readable by address | Token Program on devnet: owner `BPFLoaderUpgradeab1e…`, 36 bytes, executable |
| `inspect-transaction.ts` | A confirmed transaction can be fully decomposed | A mainnet arbitrage: 30 accounts (16 resolved through Address Lookup Tables), 8 outer instructions, 9 inner instructions, SOL and token deltas reconciled to the lamport |
| `simulate-transfer.ts` | An unsigned transaction can be simulated and post-state requested | 1 lamport to a new account → `InsufficientFundsForRent`; at the rent-exempt minimum → `err: null`, with the destination existing only inside the simulation |
| `inspect-inner-instructions.ts` | CPIs are visible before signing | Simulated ATA creation: 1 outer instruction, 4 inner instructions at `stackHeight: 2`, calling System Program and Token Program |

Every figure above came from a real RPC response, not from documentation.

### What these experiments revealed

Findings that directly shape the normalizer's design:

- **`meta.loadedAddresses` only exists after execution.** Accounts loaded through
  Address Lookup Tables are invisible before signing, so VETO must resolve the
  lookup tables itself. That is an extra RPC call inside the latency budget.
- **`simulateTransaction`'s `accounts` option returns only the addresses you
  ask for.** The RPC performs no discovery. The normalizer must build that list
  from the message, and incomplete coverage has to become a finding rather than
  silence.
- **Wrapped SOL appears twice.** In the observed swap, the lamport delta and the
  token delta on the same account were identical. Counting both would double a
  single movement.
- **`number` loses precision.** `lamports` and `rentEpoch` arrive as JavaScript
  numbers; a `rentEpoch` of `u64::MAX` came back already rounded to
  `18446744073709552000`. Token amounts arrive as strings and must be handled as
  `bigint` from the start.
- **Program logs are not a verdict.** A failing transaction printed
  `Program … success` in its logs while `err` reported
  `InsufficientFundsForRent`. The runtime's rent check runs after the
  instruction. Only `err` decides.
- **Inner instructions arrive in two different shapes.** The RPC returns
  `jsonParsed` when it can and compiled JSON (numeric account indexes) when it
  cannot. Both have to be handled; the installed SDK only validates the first.

---

## Repository layout

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
  exploration/    # exploration scripts (not part of the product)
  fixtures/       # recorded RPC responses for offline tests
docs/             # specification (Portuguese), pending work and decisions
```

The three specification documents in `docs/` are written in Portuguese and
kept as internal design notes; everything else in the repository is in English.

---

## Getting started

Requires Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env    # then fill in VETO_RPC_URL and VETO_RPC_URL_DEVNET
pnpm typecheck
pnpm test
```

RPC endpoints come from [Helius](https://dashboard.helius.dev). The API key is
embedded in the URL query string, so the whole URL is a secret — `.env` is
gitignored and no script ever prints it.

`SETUP.md` documents the toolchain, every configuration choice and how to verify
the environment.

### Scripts

```bash
pnpm test           # vitest, offline
pnpm test:watch
pnpm test:coverage
pnpm typecheck      # tsc --noEmit
```

`tsx` and `vitest` transpile with esbuild, which strips types without checking
them. `pnpm typecheck` is the only thing that validates types — run both.

### Command-line tools

```bash
# record a fixture from a real devnet simulation
pnpm exec tsx --env-file=.env src/cli/record-fixture.ts --list
pnpm exec tsx --env-file=.env src/cli/record-fixture.ts --all
```

### Running the exploration scripts

```bash
# read an account's metadata on devnet
pnpm exec tsx --env-file=.env test/exploration/read-account.ts <address>

# decompose a confirmed mainnet transaction
pnpm exec tsx --env-file=.env test/exploration/inspect-transaction.ts <signature>
```

Two further scripts — a pre-signature transfer simulation and a CPI inspector —
were removed once the fixture recorder and the normalizer superseded them. Their
findings are recorded above and in `docs/decisions.md`.

Everything here exits with a distinct code per outcome — invalid input,
configuration error, account not found, RPC failure, simulation executed with an
error, simulation executed successfully — so a failed transaction is never
confused with an unavailable RPC.

---

## Architecture decisions

These are settled. Reverting one requires a deliberate discussion.

- **No Rust on the critical path.** Everything is TypeScript. The only approved
  use of Rust is a future registry program that records the hash of an
  evaluation on-chain, with no authority over value.
- **Account-level diff, not instruction decoding.** The SPL token account layout
  is fixed; `amount`, `owner` and `delegate` are read from the bytes at known
  offsets. No universal IDL decoder. Anchor IDLs are optional enrichment for the
  alert message only.
- **Deterministic decisions.** No language model in the decision path.
- **Never judge the truthfulness of content.** Origin is tracked, and content is
  classified only by *form* — whether it carries the shape of an injected
  instruction. Whether a claim is true is never evaluated.
- **Use Lighthouse** for on-chain assertion instead of writing a custody program.
- **Degrade, never open.**
- **Wallet neutrality.** Squads is the default path for co-signing because it is
  a native program rather than a contracted vendor. Turnkey and Privy are
  shortcuts for those who already use them, never a requirement.

### Assumed physical limit

An agent holding a raw keypair on its own machine cannot be blocked by an
external service. The SDK gate is a control against corrupted reasoning, not
against a compromised host. That is a security prerequisite of the deployment,
not a claim of the product.

---

## Known limitations

Stated honestly, because the number one product risk is the false positive. A
customer who turns off the alert in week two is a customer lost.

- **Legitimate addresses from routing APIs.** An agent calling a DEX aggregator
  receives valid addresses that were never in the user's goal. Handled by
  per-source trust levels, configured during onboarding; anything unconfigured
  defaults to untrusted.
- **Obfuscated addresses.** An address assembled by concatenation or encoded in
  the context will not be found by string search. There is no complete solution;
  it is recorded as a known limitation. The content classifier partially covers
  this case, because the surrounding text usually still reads as an instruction
  even when the address itself is hidden.
- **Classifier evasion.** A small classifier can be evaded by paraphrase,
  encoding or a language switch. This is why it never blocks on its own: it
  raises severity on top of the structural checks, which observe the effect
  regardless of how the text was written.
- **Vague goals produce wide envelopes.** "Manage my portfolio" constrains almost
  nothing. This is why the envelope never blocks on its own.
- **Provenance depends on the agent framework exposing the origin of retrieved
  content.** Where it does not, the RAG and memory layers have to be
  instrumented. This is the project's largest schedule risk.
- **Simulation reflects the state of one slot.** If the transaction is signed and
  sent later, the state may have changed. Lighthouse closes that window on-chain.

---

## Roadmap

| # | Stage | Status |
|---|---|---|
| 1 | Vulnerable agent on devnet, as a target and a research artifact | not started |
| 2 | Context capture with provenance | blocked on framework choice |
| 3 | **Normalizer — unsigned tx to `EffectSet`** | **in progress — shared types and RPC layer built** |
| 3b | CLI over the normalizer: inspect a transaction, record a fixture | not started |
| 4 | Provenance detector | not started |
| 5 | SDK gate | not started |
| 6 | Tool manifests, checks A and B | not started |
| 7 | Aggregate checks and persistence | not started |
| 8 | Content classifier (check E) at ingestion, in observation mode | not started |
| 9 | Alert panel | not started |
| 10 | Remediation tiers 1 and 2 — gate, kill switch, revocations | not started |
| 11 | Remediation tier 3 — nonce accounts, planted lookup tables, pre-signed transactions | not started |
| 12 | Memory poisoning detection and tier 4 remediation | not started |
| 13 | Lighthouse on-chain assertion | not started |

Stages 1 through 5 constitute a defensible proof of concept.

The shared type layer in `src/types/` and the RPC boundary in
`src/normalization/` are built and tested. The next piece is SPL account
decoding at fixed offsets, followed by the account diff that turns a simulated
state transition into the closed effect vocabulary.

### Deliberately out of scope for now

- **Behavioral baselining (UEBA).** Requires weeks of accumulated data. When it
  arrives: the model scores, the rules decide. A baseline also has to be
  correlated with deploy events — a behavior change alongside a deploy is
  evolution, without one it is suspicion.
- **Fine-tuning the classifier on proprietary data.** The first version uses an
  off-the-shelf model as-is. A model trained on our own corpus of blocked
  attempts only becomes possible once the threat feed has accumulated real
  incidents.

The classifier enters in observation mode: it produces findings and records
scores without contributing to a block, until its false-positive rate has been
measured against real traffic. Only then does it get severity weight.

---

## Remediation

A confirmed transaction has no rollback. Remediation contains what is left — and
the damage that has not happened yet is usually larger than the damage that has.
An attacker who obtained an unlimited delegate has taken one transaction; the
loss arrives later, on their schedule.

The catalogue below is ordered by how fast it has to happen. Everything in tier 1
is automatic and pre-authorized at onboarding; everything below it is a playbook
that VETO can drive but the customer authorizes.

### Tier 1 — Stop the bleeding (seconds, automatic)

| Action | Mechanism | Difficulty |
|---|---|---|
| Refuse the signature | The gate itself. Nothing reaches the chain | trivial |
| Kill the agent process | Webhook / kill switch into the client runtime | low |
| Raise the gate level | Force the agent into observation, deny-all, or human-approval mode | low |
| Expire the task envelope | Invalidates the authorized scope; the next action requires a freshly derived envelope and, optionally, human confirmation | low |
| Trip the aggregate circuit breaker | Freeze the sliding window so further actions fail the aggregate check regardless of their individual merit | low |

### Tier 2 — Revoke standing authority (minutes)

These close permissions that survive the incident and can be used later.

| Action | Mechanism | Difficulty |
|---|---|---|
| Revoke SPL delegate | `revoke` instruction on each affected token account | low |
| Revoke Token-2022 approvals | Same, plus extension-specific authorities where present | low |
| Revoke session keys | Wallet provider API (Turnkey, Privy) | low |
| Rotate agent credentials | New keypair or provider credential; the compromised one stops being able to propose | medium |
| Reassign changed authorities | Restore mint, freeze, close and upgrade authorities to the custodian | medium |
| Remove the key from the multisig | Governance transaction on Squads; or raise the threshold | medium |
| Revoke stake authority | Reset stake and withdraw authorities on affected stake accounts | medium |

### Tier 3 — Neutralize pre-positioned infrastructure (hard, often forgotten)

This tier is what separates a real response from a cosmetic one. An agent under
attack does not only move money — it can leave loaded weapons behind.

| Action | Mechanism | Difficulty |
|---|---|---|
| **Neutralize durable nonce accounts** | A transaction signed against a durable nonce never expires. A pre-signed transfer can sit in an attacker's pocket indefinitely and land weeks later. Advance or close every nonce account the agent controls | **high** |
| **Hunt for live pre-signed transactions** | Normal transactions stay valid for roughly 150 slots (about a minute). During that window, a transaction VETO refused may already exist elsewhere, signed. Scan and, where possible, invalidate by consuming the nonce or draining the source | **high** |
| **Deactivate and close planted lookup tables** | An Address Lookup Table created by the agent can hide destination accounts from anything that inspects only the static message. Deactivate, then close after the cooldown | medium |
| **Close attacker-controlled token accounts** | Close ATAs the agent created that serve no legitimate purpose, recovering rent and removing staging ground | medium |
| **Revoke program upgrade authority** | If the agent ever held one, an upgrade authority is the highest-severity standing permission in the system | medium |

### Tier 4 — Clean the corrupted substrate

Everything above treats the wallet. This tier treats the cause. Skipping it means
the same attack fires again on the next run.

| Action | Mechanism | Difficulty |
|---|---|---|
| Quarantine poisoned memory entries | Flag the entries the classifier scored as injection; the agent stops reading them | medium |
| Roll memory back to a clean snapshot | Requires memory versioning in the client runtime. The only action in this system that genuinely undoes something | **high** |
| Blocklist the source | Domain, tool name or memory key is forced to `untrusted`, so every future address from it is critical by default | low |
| Purge the poisoned content from the RAG index | Requires write access to the client's retrieval layer | **high** |
| Force re-derivation of the envelope from a clean goal | Prevents an envelope derived while the context was already poisoned from continuing to authorize actions | medium |

### Tier 5 — Contain value

| Action | Mechanism | Difficulty |
|---|---|---|
| Sweep funds to a pre-authorized destination | Optional, opt-in. The destination is fixed by the customer in advance and **cannot be changed by VETO** | medium |
| Freeze token accounts | Only where the mint's freeze authority belongs to the customer | medium |
| Unstake and recall delegated stake | Deactivate stake accounts the agent can reach | medium |

Sweeping is the one action that tensions the core promise that VETO can only
refuse, never move. That is why the destination is immutable and set by the
customer before any incident, and why the capability is opt-in.

### Tier 6 — Learn and propagate

| Action | Mechanism | Value |
|---|---|---|
| Forensic snapshot | Persist the `ActionContext`, chunk hashes, `EffectSet`, `Verdict` and model versions | The audit trail that unlocks enterprise budget |
| Convert the incident into a rule | The blocked pattern becomes a detector | An attack blocked at one customer protects every other one |
| Publish to the threat feed | Addresses, sources and injection signatures | A product of its own |

### The honest limit

Tiers 1 and 2 are fast and reliable. Tier 3 is where most incident responses
quietly fail, which is exactly why it is listed. Tier 4 depends on how deeply the
client runtime can be instrumented, and some of it will be impossible on some
frameworks — in which case VETO says so rather than pretending coverage.

The point is not to undo what the agent did. It is to guarantee it cannot happen
again, in seconds instead of hours.

---

## Specification

Detailed design documents live in `docs/` (written in Brazilian Portuguese):

- `veto-status.md` — what is settled and what is still open
- `veto-construcao.md` — overall architecture and build order
- `veto-camada-avaliacao.md` — the evaluation engine in detail
- `pending.md` — what is missing in each block, tracked during construction
- `decisions.md` — risk decisions taken, open holes, and rejected ideas

---

License: to be defined.
