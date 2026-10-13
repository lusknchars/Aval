import { blob, Code, Ext, H2, H3, Note, Pipeline, REPO, Stats, Table, Verdicts } from './parts'

/* Sidebar order. Each id is an <H2> below. */
export const SECTIONS = [
  ['overview', 'Overview'],
  ['how-it-works', 'How it works'],
  ['architecture', 'Architecture'],
  ['quickstart', 'Quickstart'],
  ['api', 'API reference'],
  ['proofs', 'On-chain proofs'],
  ['benchmark', 'Benchmark'],
  ['security', 'Security model'],
  ['roadmap', 'Roadmap'],
  ['team', 'Team'],
] as const

export default function Content() {
  return (
    <>
      {/* ── Overview ─────────────────────────────── */}
      <section className="d-sec" aria-labelledby="overview">
        <p className="kicker">00 / overview</p>
        <H2 id="overview">What Aval is</H2>
        <p className="d-lede">
          Aval is a safety check that sits between an AI agent and its Solana wallet. It runs the unsigned
          transaction first, compares what it would actually do with what the user asked for, and returns a
          verdict before anything is signed.
        </p>

        <H3 id="the-problem">The problem</H3>
        <p>
          Agents now hold keys and move real money. The controls around them are static policies: a spending cap,
          an allowlist of programs, a list of approved destinations. None of them can answer the question that
          matters: <b>is this what the user actually asked for?</b>
        </p>
        <p>
          An agent reads a web page with injected instructions and emits a transfer to an attacker. The
          transaction is under the cap, calls an approved program and is fully authorized. It passes every policy
          check. What changed was not the amount or the program, but <i>who was really asking</i>. The same class
          of incoherent-but-authorized transaction also comes from hallucination, tool misuse and corrupted
          upstream data, which are far more frequent than a targeted attack.
        </p>
        <Table
          head={['Layer', 'Question it answers']}
          rows={[
            ['Key', 'Where the key lives, who signs'],
            ['Policy', 'What is permitted'],
            [<b>Coherence (Aval)</b>, <b>Does this make sense given the request and the history?</b>],
          ]}
        />

        <H3 id="verdicts">Verdicts</H3>
        <Verdicts />
        <p className="d-small">
          The engine names the middle verdict <code>flag</code> and the lab benchmark calls the last one{' '}
          <code>BLOCK</code>; they are the same three outcomes.
        </p>
      </section>

      {/* ── How it works ─────────────────────────── */}
      <section className="d-sec" aria-labelledby="how-it-works">
        <p className="kicker">01 / pipeline</p>
        <H2 id="how-it-works">How it works</H2>
        <p className="d-lede">
          Aval hooks into the agent's runtime at two points: it records context as it enters the model, with
          where each piece came from, and it checks the unsigned transaction before the wallet signs it.
        </p>
        <Pipeline />

        <H3 id="stages">The stages</H3>
        <ol className="d-steps">
          <li><b>Intercept.</b> The agent's tool call and unsigned transaction are held at the gate instead of going to the network.</li>
          <li><b>Simulate.</b> <code>aval-svm</code> replays the transaction in a local Solana VM (LiteSVM), loading accounts from a mainnet RPC only on a cache miss.</li>
          <li><b>Read effects.</b> Pre and post account states are diffed into a closed vocabulary of eight effect types: <code>BALANCE_DECREASE</code>, <code>BALANCE_INCREASE</code>, <code>DELEGATE_GRANT</code>, <code>AUTHORITY_CHANGE</code>, <code>OWNER_CHANGE</code>, <code>ACCOUNT_CREATE</code>, <code>ACCOUNT_CLOSE</code>, <code>PROGRAM_INVOKE</code>. They come from the account model, not from decoding instructions, so a program Aval has never seen still produces them.</li>
          <li><b>Trace origin.</b> Every counterparty that receives value or authority is looked up in the context: named in the user's goal, in the allowlist, from a trusted tool, or only in a <code>retrieved</code>, <code>memory</code> or <code>tool_output</code> chunk. An address that appears nowhere is critical too.</li>
          <li><b>Checks.</b> Each check emits named findings with a severity.</li>
          <li><b>Decide.</b> A severity ceiling, not a weighted score, turns findings into a verdict.</li>
        </ol>

        <H3 id="checks">The checks</H3>
        <Table
          head={['Check', 'Question', 'Catches']}
          rows={[
            ['Undeclared effect', 'Does the transaction do anything the tool manifest does not allow?', 'A delegate granted during a swap'],
            ['Magnitude', 'Does the amount match what the tool call declared?', 'Declared 10, moved 500'],
            ['Provenance', 'Where did this counterparty address come from?', 'Indirect prompt injection'],
            ['Aggregate', 'What has happened across a time window?', 'A hundred transfers of 499 under a 500 cap'],
            ['Content', 'Does a context chunk carry the shape of an injected instruction?', 'Poisoned retrieval or memory'],
          ]}
        />
        <Code lang="severity ceiling">{`
any critical finding        → DENY
two or more high findings   → DENY
one high finding            → REVIEW
only medium or low          → REVIEW above threshold, otherwise ALLOW
no findings                 → ALLOW`}</Code>

        <H3 id="model-rule">The model gives an opinion, the code decides</H3>
        <p>
          The decision path is deterministic code. A fine-tuned model reads the case after the code has decided,
          and its opinion is applied by one rule: the decision that comes out is never less severe than the one
          that went in. The model can turn ALLOW into REVIEW or DENY; it cannot release a transaction the code
          held, and an unavailable model leaves the code's verdict standing, with a finding that says so.
        </p>
        <p>
          In the lab's benchmark the same rule reads: the final decision is the most restrictive of layer A
          (simulation compared with the stated intent), layer B (injection detector) and layer C (the model).
        </p>
        <Note title="Degrade, never open">
          <p>
            A tool with no manifest disables the undeclared-effect and magnitude checks, but provenance and
            aggregate keep running, and authority changes, owner changes and unlimited delegate grants stay
            critical without a manifest that allows them.
          </p>
        </Note>
      </section>

      {/* ── Architecture ─────────────────────────── */}
      <section className="d-sec" aria-labelledby="architecture">
        <p className="kicker">02 / architecture</p>
        <H2 id="architecture">Architecture</H2>
        <p className="d-lede">One monorepo, four parts. Each runs on its own and talks to the others over HTTP.</p>
        <Code lang="layout">{`
 agent ── context + tool call + unsigned tx ──▶ engine/        (TypeScript, :5173)
                                                  │  simulateTransaction
                                                  ▼
                                                lab/svm  aval-svm  (Rust, :8899)
                                                  │  cache misses only
                                                  ▼
                                                mainnet RPC

 engine verdicts (JSONL) ──▶ aval-svm anchor ──▶ aval_registry  (Anchor program)
 lab/  layers A · B · C, dataset, benchmark  ──▶ API :8070
 web/  landing page + operator console`}</Code>

        <H3 id="arch-engine">engine: TypeScript core</H3>
        <p>
          The core library. It captures context with provenance as it enters the agent, normalizes the simulated
          transaction into an effect set, runs the checks and produces the verdict. No language model sits in its
          decision path. Every verdict is written to an append-only JSONL record with the policy version in force.{' '}
          <Ext href={blob('engine/README.md')}>engine/README.md</Ext>
        </p>

        <H3 id="arch-svm">aval-svm: local Solana VM (Rust)</H3>
        <ul className="d-list">
          <li><b>Drop-in JSON-RPC.</b> Serves <code>simulateTransaction</code> locally and forwards every other method to the upstream RPC unchanged. Callers change one URL.</li>
          <li><b>LiteSVM pool.</b> A pool of pre-warmed VMs with the common programs preloaded. A simulation never commits state.</li>
          <li><b>Account cache.</b> Misses go in a single <code>getMultipleAccounts</code> (up to 100 keys). Plain accounts expire after 2,000 ms, program accounts after 60,000 ms.</li>
          <li><b>Two-RPC cross-check.</b> With a second provider set, every fetch is compared. Disagreement on signer, program or lookup-table accounts refuses the request; disagreement elsewhere simulates both versions and refuses if the outcomes diverge for the user.</li>
          <li><b>Projection.</b> <code>/v1/project</code> returns what the transaction would do: SOL and token deltas, authority changes, created and closed accounts.</li>
          <li><b>Digest.</b> Every reply carries a sha256 of the message bytes, the same value the engine computes, plus the slot of the state it used.</li>
        </ul>
        <p><Ext href={blob('lab/svm/docs/2026-10-06-aval-svm-design.md')}>aval-svm design spec</Ext></p>

        <H3 id="arch-registry">aval-registry: on-chain attestation</H3>
        <p>
          An Anchor program that stores Merkle roots of verdict batches, so any single verdict line can later be
          proven unaltered. It has two instructions, <code>init_registry</code> and <code>anchor_batch</code>, and
          no update, close or authority-transfer instruction. It holds no value and never takes custody. The
          batcher (<code>aval-svm anchor</code>) tails the engine's record file and the verifier
          (<code>aval-svm verify</code>) checks a line against the chain.{' '}
          <Ext href={blob('lab/svm/docs/2026-10-06-aval-registry-design.md')}>registry design spec</Ext>
        </p>

        <H3 id="arch-lab">lab: intent model and benchmark (Python)</H3>
        <ul className="d-list">
          <li><b>Layer A:</b> simulation compared with the stated intent.</li>
          <li><b>Layer B:</b> injection pattern detector.</li>
          <li><b>Layer C:</b> Qwen2.5-Coder-1.5B-Instruct with a LoRA adapter trained locally with MLX on effects of real transactions. It may only tighten the verdict.</li>
          <li>The adversarial evaluation, the training dataset and the 1,000 and 20,000 transaction benchmarks, served by one API on port 8070.</li>
        </ul>
        <p><Ext href={blob('lab/README.md')}>lab/README.md</Ext> <span className="d-small">(Portuguese)</span></p>
      </section>

      {/* ── Quickstart ───────────────────────────── */}
      <section className="d-sec" aria-labelledby="quickstart">
        <p className="kicker">03 / quickstart</p>
        <H2 id="quickstart">Run the demo locally</H2>
        <p className="d-lede">
          Requirements: Node 22+, pnpm 12, Rust stable (1.97.1 or newer), Python 3.11+ and a mainnet RPC URL
          (Helius or similar). For the registry, the Solana CLI (Agave) and Anchor.
        </p>
        <Code lang="bash" title="clone">{`
git clone ${REPO}.git
cd Aval`}</Code>

        <H3 id="qs-engine">1. Engine on :5173</H3>
        <Code lang="bash">{`
cd engine
cp .env.example .env        # set AVAL_RPC_URL to your mainnet RPC URL; .env is git-ignored
npx -y pnpm@12.4.2 install
npx -y pnpm@12.4.2 demo     # http://127.0.0.1:5173`}</Code>
        <p className="d-small">
          The RPC URL is treated as a secret (the API key lives in its query string). It stays on the server and
          never reaches the browser.
        </p>

        <H3 id="qs-svm">2. aval-svm on :8899</H3>
        <Code lang="bash">{`
cd lab/svm
cargo build --release
AVAL_UPSTREAM_URL="https://mainnet.helius-rpc.com/?api-key=<your key>" \\
  ./target/release/aval-svm serve --config aval-svm.toml      # 127.0.0.1:8899`}</Code>

        <H3 id="qs-lab">3. Lab API on :8070</H3>
        <Code lang="bash">{`
cd lab
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m src.unified_api --host 127.0.0.1 --port 8070`}</Code>
        <p className="d-small">The model layer needs the model files; without them the code layers still answer.</p>

        <H3 id="qs-web">4. Web console on :4173</H3>
        <Code lang="bash">{`
cd web
npm ci
npm run local      # builds, then serves on 127.0.0.1:4173`}</Code>
        <p>
          Open <code>http://127.0.0.1:4173/app/#/live</code> (live gate) and{' '}
          <code>http://127.0.0.1:4173/app/#/replay/focus</code> (replay). The console proxies <code>/veto</code>,{' '}
          <code>/svm</code> and <code>/lab</code> to the three services above; override them with{' '}
          <code>VETO_URL</code>, <code>SVM_URL</code> and <code>LAB_URL</code>.
        </p>

        <H3 id="qs-registry">5. Registry on a local validator</H3>
        <p>Zero cost: a local validator on port 8999 with simulated SOL and the program preloaded.</p>
        <Code lang="bash">{`
cd lab
registry/scripts/localnet.sh --demo-records        # validator on :8999, program loaded, results/demo-records.jsonl
export AVAL_REGISTRY_RPC=http://127.0.0.1:8999
./svm/target/release/aval-svm anchor --records results/demo-records.jsonl \\
    --keypair ~/.config/solana/id.json --once
./svm/target/release/aval-svm verify --records results/demo-records.jsonl --line 7 \\
    --authority $(solana-keygen pubkey ~/.config/solana/id.json)   # retry after ~15 s if PENDING
registry/scripts/localnet.sh --stop`}</Code>
        <Code lang="output" title="expected">{`
anchored batch 0: lines 0–9 (10 records) tx …
VERIFIED line 7 — batch 0, slot …, registry … (authority <your wallet>)`}</Code>
        <p className="d-small">
          The program keypair is never committed: on a clean clone the script loads the committed <code>.so</code>{' '}
          fixture into genesis under the same program id.
        </p>
      </section>

      {/* ── API ──────────────────────────────────── */}
      <section className="d-sec" aria-labelledby="api">
        <p className="kicker">04 / api</p>
        <H2 id="api">API reference</H2>
        <p className="d-lede">
          Every service binds to <code>127.0.0.1</code> by default. Shapes below are taken from the source; where
          a response is large, the linked file is the reference.
        </p>

        <H3 id="api-svm-rpc">aval-svm · POST / (JSON-RPC)</H3>
        <p>
          <code>simulateTransaction(tx, config)</code> runs locally. <code>getMultipleAccounts</code> with{' '}
          <code>encoding: "base64"</code> and 1–100 keys is served from the same cache. Every other method
          (<code>getLatestBlockhash</code>, <code>getAccountInfo</code>, …) is proxied unchanged.{' '}
          <code>GET /health</code> returns <code>{'{"ok":true}'}</code>.
        </p>
        <Table
          head={['Option', 'Supported']}
          rows={[
            [<code>encoding: base64 | base58</code>, 'yes'],
            [<code>sigVerify: false</code>, <>yes; <code>true</code> is rejected with <code>-32602</code> (callers simulate unsigned transactions)</>],
            [<code>replaceRecentBlockhash: true</code>, <>yes; the reply's <code>replacementBlockhash</code> is the local VM's, never sign with it</>],
            [<code>commitment</code>, 'used for upstream fetches'],
            [<code>accounts: {'{encoding: base64, addresses}'}</code>, 'post-state of the listed addresses'],
            [<code>innerInstructions: true</code>, 'yes'],
            [<code>minContextSlot</code>, 'ignored'],
          ]}
        />
        <p>
          The reply has the standard RPC shape{' '}
          <code>{'{context:{slot}, value:{err, logs, accounts, unitsConsumed, returnData, innerInstructions, replacementBlockhash}}'}</code>{' '}
          plus one extra top-level field that strict parsers ignore:
        </p>
        <Code lang="json">{`
"aval": { "digest": "<64 hex>", "stateSlot": 312345678, "stateSlotMin": 312345677,
          "cache": { "hits": 11, "misses": 2 }, "elapsedUs": 4210 }`}</Code>
        <p className="d-small">
          <code>stateSlot</code> is the newest slot of any read; <code>stateSlotMin</code> the oldest among
          non-program accounts. Send <code>{'"aval": {"fresh": true}'}</code> to bypass the cache for plain
          accounts, or <code>{'"aval": {"worlds": true}'}</code> to receive both simulated worlds when two
          providers disagree.
        </p>

        <H3 id="api-svm-project">aval-svm · POST /v1/project</H3>
        <Code lang="json" title="request">{`
{ "transaction": "<base64>", "fresh": false }`}</Code>
        <Code lang="json" title="response">{`
{
  "ok": true, "err": null, "unitsConsumed": 4123, "logs": ["…"],
  "projection": {
    "sol":    [{ "account": "…", "pre": 1000000000, "post": 994995000 }],
    "tokens": [{ "account": "…", "mint": "…", "owner": "…",
                 "pre": "5000000", "post": "0", "decimals": 6 }],
    "authority": [{ "account": "…", "field": "owner|delegate|closeAuthority",
                    "pre": "…", "post": "…" }],
    "closed": ["…"], "created": ["…"]
  },
  "aval": { "digest": "<64 hex>", "stateSlot": 312345678, "stateSlotMin": 312345677,
            "cache": { "hits": 11, "misses": 2 }, "elapsedUs": 4210 }
}`}</Code>
        <p className="d-small">
          Token amounts are strings (u64). <code>tokens[].owner</code> is the owner before the transaction. When
          two providers disagree on tolerated accounts, the response adds <code>projectionAlternate</code>.
        </p>

        <H3 id="api-svm-errors">aval-svm · errors</H3>
        <Table
          head={['Code', 'When']}
          rows={[
            [<code>-32602</code>, 'Malformed transaction, larger than 4096 bytes, sigVerify: true, or too many accounts'],
            [<code>-32004</code>, 'Program not loadable in the VM; the caller can fall back to a public RPC'],
            [<code>-32005</code>, 'Upstream unavailable with cache misses, providers disagree on a strict account, or the two simulated worlds diverge. Never a fake success'],
            [<code>value.err</code>, 'The transaction fails in the VM: a normal reply, same as RPC'],
          ]}
        />

        <H3 id="api-evaluate">engine · POST /evaluate</H3>
        <p>
          Runs the whole pipeline on one transaction and returns the full stage-by-stage result (captured context,
          tool call and manifest, effects, origin of every counterparty, findings, verdict). Nothing is signed and
          nothing is sent. Every call is appended to the engine's record file.
        </p>
        <Table
          head={['Field', 'Type', 'Meaning']}
          rows={[
            [<code>goal</code>, 'string, required', "The user's request, stamped with provenance user"],
            [<code>transaction</code>, 'string', 'A recorded fixture name or a mainnet signature (80+ characters is read as a signature)'],
            [<code>fixture</code>, 'string', <>A recorded scenario: <code>unlimited-approve</code>, <code>transfer-sol</code>, <code>token-to-wallet</code>, <code>create-ata</code>, <code>close-account</code>, <code>rent-failure</code></>],
            [<code>signature</code>, 'string', 'A mainnet transaction signature'],
            [<code>tx</code>, 'string', 'A base64 transaction'],
            [<code>network</code>, <code>mainnet | devnet</code>, 'Default mainnet'],
            [<code>retrieved</code>, 'string', 'Text the agent read, added to the context as one chunk'],
            [<code>provenance</code>, <code>retrieved | memory | tool_output</code>, <>Where that text came from; default <code>retrieved</code></>],
            [<code>source</code>, 'string', 'Where the retrieved text came from (URL, tool name, memory key)'],
            [<code>allowlist</code>, 'string[]', 'Addresses the customer approved in advance'],
            [<code>tool</code>, 'string', 'Override the tool name the manifest is looked up by'],
            [<code>declaredAmount</code>, 'string', 'The amount the agent said; replaces the one inferred from the effects'],
          ]}
        />
        <Code lang="bash" title="example">{`
curl -s http://127.0.0.1:5173/evaluate \\
  -H 'content-type: application/json' \\
  -d '{"goal":"rebalance my portfolio","fixture":"unlimited-approve"}'`}</Code>
        <p className="d-small">
          Errors come back as <code>{'{"error": "…"}'}</code>; a server fault never includes a stack trace. The
          response shape is built in{' '}
          <Ext href={blob('engine/src/demo/server.ts')}>engine/src/demo/server.ts</Ext>; see it for the full
          object and for the other demo routes.
        </p>

        <H3 id="api-cli">aval-svm · command line</H3>
        <Table
          head={['Command', 'Does']}
          rows={[
            [<code>serve --config &lt;toml&gt;</code>, 'The JSON-RPC server (default 127.0.0.1:8899)'],
            [<code>digest &lt;base64 tx&gt;</code>, "Prints the message digest, the same value the engine computes"],
            [<code>shadow --count 200</code>, 'Compares aval-svm with the upstream RPC on real transactions from one block'],
            [<code>anchor --records … --keypair … [--once]</code>, 'Anchors Merkle roots of new record lines (every 30 s or 256 lines by default)'],
            [<code>verify --records … --line N [--authority &lt;pubkey&gt;]</code>, 'Proves one record line against the chain'],
          ]}
        />
        <Code lang="text" title="verify">{`
aval-svm verify --records <records.jsonl> --line N [--proofs <file>] [--upstream <rpc>]
                [--authority <pubkey>] [--cross-check <rpc>]`}</Code>
        <Table
          head={['Exit code', 'Meaning']}
          rows={[
            [<code>0</code>, <><code>VERIFIED line N — batch k, slot S, …</code></>],
            [<code>1</code>, <><code>NOT VERIFIED: …</code> tampered line, wrong line, wrong authority</>],
            [<code>2</code>, <>Could not check: I/O, RPC unreachable, bad arguments, or <code>PENDING</code> (not finalized yet; retry in ~15 s)</>],
          ]}
        />
        <p className="d-small">
          <code>--authority</code> pins the registry to that authority instead of trusting the proofs file.{' '}
          <code>--cross-check</code> (or <code>AVAL_REGISTRY_RPC_2</code>) reads every account from a second RPC
          and exits 2 if they differ. The RPC comes from <code>--upstream</code> or <code>AVAL_REGISTRY_RPC</code>.
        </p>

        <H3 id="api-bench">lab · benchmark endpoints</H3>
        <p>
          Read-only, unauthenticated, never a 500: a missing file is an empty answer. Served by the lab API on
          :8070 (start it with <code>--no-guard</code> if the Prompt Guard model is not downloaded).
        </p>
        <Table
          head={['Route', 'Returns']}
          rows={[
            [<code>GET /v1/benchmark/summary</code>, <>The current <code>summary.json</code> (totals per set), or <code>{'{}'}</code></>],
            [<code>GET /v1/benchmark/events?since=&lt;n&gt;&amp;limit=&lt;n&gt;</code>, <><code>{'{"events": [...], "next": <offset>, "total": <lines>}'}</code></>],
          ]}
        />
        <p>
          <code>since</code> (default 0) is a line number; <code>limit</code> defaults to 100 and is capped at
          1000. Poll with <code>since=next</code> every 1–2 s. A non-integer or negative parameter is a 400. Event
          types are <code>decision</code> (layers A+B, as soon as a case is processed), <code>model</code> (layer C,
          later) and <code>baseline</code> (the untuned model on a sample); join them by <code>case_id</code> and
          ignore unknown types.
        </p>
        <Code lang="json" title="a decision event">{`
{"type": "decision", "case_id": "ar-c5cb24fe23fed70c", "set": "attack_real_tx", "source": "mainnet",
 "kind": "injected_instruction", "expected": "BLOCK", "decision": "BLOCK", "layer": "B",
 "signals": ["injected_instruction"], "reasons": ["…"],
 "layers": {"A": "ALLOW", "B": "BLOCK"}, "latency_ms": {"A": 0.0049, "B": 0.0038}, "usd": 15.25,
 "tx_digest": "c5cb24fe23fed70c…", "ts": "2026-10-10T18:17:00.481+00:00"}`}</Code>
        <p className="d-small">
          Sets are <code>real_traffic</code>, <code>attack_real_tx</code> and <code>attack_constructed</code>; never
          add one to another. Field-by-field reference:{' '}
          <Ext href={blob('lab/docs/benchmark-api.md')}>lab/docs/benchmark-api.md</Ext>{' '}
          <span>(Portuguese, field names in English)</span>.
        </p>
      </section>

      {/* ── Proofs ───────────────────────────────── */}
      <section className="d-sec" aria-labelledby="proofs">
        <p className="kicker">05 / proofs</p>
        <H2 id="proofs">On-chain proofs</H2>
        <p className="d-lede">
          An append-only file on a disk the operator controls is a promise, not evidence. The registry turns each
          verdict line into something anyone can check with the line, its proof and an RPC endpoint.
        </p>

        <H3 id="proofs-how">How a verdict is anchored</H3>
        <ol className="d-steps">
          <li>The engine appends one verdict per line to a JSONL file.</li>
          <li>The batcher hashes each complete line: <code>leaf = sha256(0x00 ‖ line)</code>, <code>node = sha256(0x01 ‖ left ‖ right)</code>. The prefixes keep a leaf from passing as an inner node; an unpaired node is promoted, never duplicated.</li>
          <li>It sends <code>anchor_batch(root, first_record, count)</code>. The program only accepts contiguous batches (no gaps, no overlap, no replay) from the registry's authority, and stores the root with the slot and time.</li>
          <li>Proofs go to <code>&lt;records&gt;.proofs.jsonl</code>. If an anchored line is later edited, or the file is truncated, the batcher refuses to run.</li>
        </ol>

        <H3 id="proofs-proves">What VERIFIED proves</H3>
        <ul className="d-list d-list--ok">
          <li>The exact bytes of line N are the ones committed in batch k, at slot S, by the registry's authority.</li>
          <li>The line was not edited after it was anchored: the leaf is recomputed from the line, not read from the proofs file.</li>
          <li>The proof is for line N's position in that batch; a valid proof for another line cannot be passed off.</li>
          <li>With <code>--authority</code>, the registry is the one that authority owns, not whatever the proofs file names.</li>
        </ul>

        <H3 id="proofs-not">What it does not prove</H3>
        <ul className="d-list d-list--no">
          <li>That the verdict was right. The registry attests what was written, not whether it was correct; a malformed line is anchored as bytes too.</li>
          <li>That every verdict was anchored. An operator can leave the tail of the file unanchored, or alter lines before they are anchored. That is visible only by comparing the records file with the proofs file.</li>
          <li>Anything about the simulation itself. The verdict is attested, not the aval-svm run behind it.</li>
          <li>Anything before finality. <code>verify</code> reads at <code>finalized</code>; a fresh batch answers <code>PENDING</code> for ~15 s.</li>
        </ul>
        <Note title="Where it runs">
          <p>
            The demo uses a local validator (zero cost). Devnet is an optional step; there is no mainnet
            deployment. Gaps in the middle of the anchored history are impossible because batches are contiguous.
          </p>
        </Note>
      </section>

      {/* ── Benchmark ────────────────────────────── */}
      <section className="d-sec" aria-labelledby="benchmark">
        <p className="kicker">06 / benchmark</p>
        <H2 id="benchmark">Benchmark: 20k run on mainnet</H2>
        <p className="d-lede">
          Real Solana mainnet transactions and two attack suites, finished 2026-10-11. Numbers from{' '}
          <Ext href={blob('reports/bench20k/summary.json')}>summary.json</Ext> and{' '}
          <Ext href={blob('reports/bench20k/headline.json')}>headline.json</Ext>.
        </p>
        <Stats
          items={[
            ['22,686', 'real mainnet transactions'],
            ['0', 'false blocks'],
            ['2,000 / 2,000', 'attacks on real transactions blocked'],
            ['4,000 / 4,000', 'constructed attacks blocked'],
          ]}
        />

        <H3 id="bench-real">Real traffic</H3>
        <Table
          head={['', 'Approved', 'REVIEW', 'Blocked']}
          rows={[
            ['Code checks alone (22,686)', '100%', '0', '0'],
            ['With the model, all real traffic (22,686)', '72.2% (16,370)', '27.8% (6,316)', '0'],
            ['Model-scored subset only (15,076)', '58.1% (8,760)', '41.9% (6,316)', '0'],
          ]}
        />
        <p className="d-small">
          REVIEW falls mostly on swaps: 86% of the model-scored swaps (4,980 of 5,805) went to REVIEW.
        </p>

        <H3 id="bench-attacks">Attacks</H3>
        <Table
          head={['Suite', 'Result']}
          rows={[
            ['Attacks forged on real transactions', '2,000 / 2,000 blocked (1,367 by layer A, 633 by layer B)'],
            ['Constructed attacks (local VM)', '4,000 / 4,000 blocked'],
            ['Their honest twins', '3,999 / 4,000 approved, 1 REVIEW, 0 blocked'],
          ]}
        />
        <p className="d-small">
          Attack kinds: recipient mismatch, amount understated, asset mismatch, approval exceeding intent,
          undeclared approval, undeclared authority change, undeclared close, injected instruction.
        </p>

        <H3 id="bench-latency">Latency</H3>
        <Table
          head={['Layer', 'p50', 'p95']}
          rows={[
            ['Code checks (A+B)', '16 µs', '35 µs'],
            ['Model (C)', 'about 1.4 s', '3.6 s'],
          ]}
        />
        <p className="d-small">Model latency measured with MLX on an Apple M4 Pro.</p>

        <H3 id="bench-limits">Limitations: read these with the numbers</H3>
        <ul className="d-list d-list--warn">
          <li><b>The attacks are forged test cases.</b> The 2,000 attacks on real transactions are real mainnet transactions paired with a forged user intent they contradict, plus test-only injected text. The 4,000 constructed attacks run in the local VM. None is a captured real-world attack.</li>
          <li><b>The code catches match the labels by construction.</b> Layer A labels a case with the same comparison of intent against simulated effects that it uses to decide, so its 100% shows the mechanism works end to end, not independent skill. The independent measure is the model on its own.</li>
          <li><b>The model scored a sample.</b> It runs at under one case per second and fell behind the collector, so from 2026-10-11 09:34 UTC it scored a seeded sample (seed 20261010: 60% of real traffic, 50% of constructed cases). It scored 15,076 of the 22,686 real transactions (66.5%); the other 7,610 show the code-only result.</li>
          <li><b>REVIEW is a cost.</b> No honest transaction was blocked, but more than a quarter of real traffic would wait for a person.</li>
        </ul>
        <p>
          <Ext href={blob('reports/aval-solana-report-20k.pdf')}>Full report (PDF, Portuguese)</Ext>
        </p>
      </section>

      {/* ── Security ─────────────────────────────── */}
      <section className="d-sec" aria-labelledby="security">
        <p className="kicker">07 / security</p>
        <H2 id="security">Security model</H2>
        <ul className="d-list d-list--plain">
          <li>
            <b>Fail closed.</b> Missing information never becomes an ALLOW. An unreachable RPC with cache misses
            is an error (<code>-32005</code>), never a fake success; the lab maps it to REVIEW. An unavailable model
            leaves the code's verdict standing.
          </li>
          <li>
            <b>A lying RPC can only make Aval stricter.</b> With two providers set and at least one honest,
            disagreement on signers, programs or lookup tables refuses the request, and diverging outcomes for the
            user refuse it too. The one bound: a lying pool or oracle view can shift the user's result by up to
            the divergence tolerance (50 bps by default) undetected.
          </li>
          <li>
            <b>Keys are never logged.</b> The registry keypair is read from a file path, never printed and never
            written anywhere. The RPC URL, which carries the API key, stays on the server and is kept out of
            error messages; <code>.env</code> is git-ignored and keypairs are never committed.
          </li>
          <li>
            <b>Simulation only.</b> Aval simulates unsigned transactions (<code>sigVerify: false</code>). It never
            signs or sends a user's transaction and holds no user key. The only transactions it sends are the
            registry's own (creating the registry and anchoring batches), signed with the operator's keypair.
          </li>
          <li>
            <b>Out of scope.</b> An agent holding a raw keypair on its own machine cannot be blocked by an external
            service. The gate protects against corrupted reasoning, not a compromised host. And a simulation
            reflects one slot: state can change before a transaction is sent.
          </li>
        </ul>
      </section>

      {/* ── Roadmap ──────────────────────────────── */}
      <section className="d-sec" aria-labelledby="roadmap">
        <p className="kicker">08 / roadmap</p>
        <H2 id="roadmap">Roadmap</H2>
        <ul className="d-roadmap">
          <li>
            <b>Sandwich and MEV stress test</b>
            <span>Measure how Aval behaves when the state moves between simulation and landing.{' '}
              <Ext href={blob('lab/STRESS_TEST_SANDUICHE.md')}>proposal</Ext></span>
          </li>
          <li>
            <b>More chains</b>
            <span>EVM transactions checked the same way, with their proofs anchored on Solana.</span>
          </li>
          <li>
            <b>Wallet and MCP integration</b>
            <span>Aval as a step wallets and agent tool servers call before asking for a signature.</span>
          </li>
        </ul>
      </section>

      {/* ── Team ─────────────────────────────────── */}
      <section className="d-sec" aria-labelledby="team">
        <p className="kicker">09 / team</p>
        <H2 id="team">Team</H2>
        <ul className="d-team">
          <li>
            <b>Lucas Oliveira</b>
            <Ext href="https://github.com/lusknchars">@lusknchars</Ext>
            <span>aval-svm, aval-registry, dataset, MLX training, benchmarks, web</span>
          </li>
          <li>
            <b>Luis Pessoa</b>
            <Ext href="https://github.com/Luispessoa18">@Luispessoa18</Ext>
            <span>the lab: fine-tuned security model, adversarial evaluation suite</span>
          </li>
          <li>
            <b>Eric Ferraz</b>
            <Ext href="https://github.com/ericferrazp">@ericferrazp</Ext>
            <span>engine: the TypeScript core</span>
          </li>
        </ul>
        <p className="d-small">Built for the Superteam Brasil Solana hackathon, October 2026.</p>
      </section>
    </>
  )
}
