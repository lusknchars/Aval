# The pipeline page

```bash
pnpm demo
```

Opens on <http://127.0.0.1:5173>. Nothing is signed and nothing is sent: the
page reads state and simulates, and the RPC url never leaves the server.

## What you are looking at

Six stages, in the order the library runs them. Every one is rendered from the
objects the library itself produced — the page computes nothing.

| | Stage | What it answers |
|---|---|---|
| **1** | what was captured | which text the agent saw, and how each piece was stamped at ingestion |
| **2** | the tool call | what the agent said it was going to do, and the manifest that governs it |
| **3** | the transaction | what it would actually do, in the nine effect types |
| **C** | counterparties | where every address that receives anything came from |
| **=** | what fired | the findings, with severity and the rule name |
| **→** | the verdict | the severity ceiling, in order, with the line that decided |

## The five-minute tour

**1. Press Evaluate.** The defaults load a recorded `unlimited-approve` and a
vague goal. It comes back **DENY**, because the delegate being granted
unlimited spending power appears nowhere in anything the user said.

**2. Look at stage C.** One counterparty, origin `unexplained`. Next to it are
two buttons.

**3. Press "the user asked for it".** The page rewrites the goal to name that
exact address and runs again. Same transaction, same bytes, same manifest —
now **ALLOW**. Origin is `user_goal`.

**4. Press "a web page said it".** The address moves out of the goal and into a
chunk stamped `retrieved`, with a source. Now **DENY**, and the rule is
`provenance.untrusted_source`.

That is the whole product in three clicks: *the transaction never changed.*
Only where the argument came from did.

**5. Read stage → after each run.** The four comparisons are the same ones the
code makes, and the highlighted line is the one that produced the answer.
There is no weighted score anywhere to inspect, because there is none.

## The agent, for real

The panel at the top runs an actual model. It reads, it decides, it builds the
transaction, and VETO is called at the moment a wallet would be asked to sign.
Nothing is signed and nothing is sent, and no private key exists anywhere in
that path -- the wallet is an address used as fee payer.

It needs a key:

```bash
# in .env, which is gitignored
ANTHROPIC_API_KEY=sk-ant-...
```

Leave **"servir ao agente uma página com um endereço que ninguém digitou"**
ticked and press Run. The model is given a `read_page` tool, the page it
fetches carries a deposit address, and the model acts on it. Nobody types an
address at any point.

Watch the three levels afterwards. Level 1 shows the page stamped
`tool_output` with its source, because the CAPTURE stamped it -- the model was
never asked where its information came from, and a compromised one would have
said `user`. Level 2 is the tool call the model genuinely chose. Level 3 is
what the resulting bytes would do.

Untick the box and ask for something specific instead -- "send 0.001 SOL to
&lt;address&gt;" -- and the same machinery comes back ALLOW, because the
address is in what you wrote.

## Watching what is landing right now

Press **Load a recent block**. It reads a block that just finalized and lists
the transactions in it, with their version, their top-level programs, their
size and the fee the network charged. Nothing is simulated at this point —
listing twenty-five transactions must not cost twenty-five pipelines.

Press **evaluate** on any row and the full pipeline runs on that one.

Two things to expect, and neither is a defect:

**Most rows are not primitives we cover.** Mainnet traffic is arbitrage and
market-making bots, not agents. Those come back `unknown_tool` →
`coverage.no_manifest` → FLAG, which is the honest answer: checks A and B did
not run, and that is reported rather than passed over.

**Many would fail on re-simulation.** A transaction that already landed is
being replayed against the state of right now, and an arbitrage that was
profitable at its own slot usually is not any more. That shows as
`transaction_would_fail`, which is information about the chain.

Rows whose programs read `Token`, `System` or `Associated Token` with a small
account count are the ones most likely to map to a primitive and produce a
verdict with real checks behind it.

## The fields

**What the user asked for.** Level 1. Stamped `user`, which is the most trusted
tier — by convention, and that convention only holds because nobody edits it.

**What the agent read** and **where it came from.** A second chunk, stamped at
ingestion. With no configured trust for that source it counts as untrusted, so
an address that appears only here is a critical finding.

**Stamped at ingestion as.** `retrieved`, `tool_output` or `memory`. In
production the agent never gets to choose this — a compromised agent would
stamp everything `user`. Here you choose it because you are playing both parts.

**Recorded transaction.** Six scenarios recorded from devnet, so they work with
no network at all.

**Mainnet signature.** Select *"use a mainnet signature instead"* in the picker
to enable the field. A real transaction carries no tool call, so the
declaration a truthful agent would have made is read back out of its own
effects — the same strict classifier the bulk sampler uses. Historical
transactions re-simulated against today's state often would fail, which shows
up as `transaction_would_fail`; that is information about the chain, not about
the tool.

## What the footer means

`policy` is a hash of everything in force — manifests, thresholds, customer
configuration. Change one severity and it changes on its own.

`message` is the sha256 of the signable message. It is what ties the verdict to
one specific transaction: whoever signs is expected to check that what they
sign hashes to this. Otherwise the verdict is about nothing in particular.

`observed N of M accounts` is the coverage. Fewer observed than referenced is
normal — readonly accounts cannot change state — but it is always stated rather
than assumed.

## What is honestly missing here

Stage 1 is you typing what the agent read. In production nobody types it: the
capture layer stamps every chunk at the door, outside the agent's control. The
page shows exactly the interface that layer has to fill.

And there is no gate. The verdict is computed and displayed; nothing yet holds
a signature back.
