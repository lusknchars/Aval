"""Benchmark da decisão do Aval em transações que o modelo nunca viu no treino.

Cada caso é UMA transação (mainnet amostrada e simulada pelo aval-svm, ou sintética construída na VM
local) com a intenção honesta derivada dos efeitos (esperado ALLOW) ou com UMA mutação do
``svm_dataset`` (esperado BLOCK). Injeções usam só ``TEST_ONLY_INJECTIONS`` (nunca vistas no treino).

Pipeline por caso, na ordem A → B → C; a decisão final é a mais restritiva:

* Camada A — simulação + comparação determinística (código): ``label`` da intenção contra os efeitos
  simulados, sem metadados. Qualquer sinal → BLOCK.
* Camada B — detector de injeção (código): ``INJECTION_PATTERN`` nos metadados → BLOCK.
* Camada C — IA de intenção (modelo ajustado, guloso). "O LLM opina, o código decide": ela só AUMENTA o
  risco. ``high`` com ``injected_instruction`` → BLOCK; ``high`` com outros sinais → REVIEW; ``low`` não
  derruba A/B.

    python -m src.aval_benchmark cases --mainnet results/bench_effects_mainnet.v2.jsonl \\
        --synthetic results/bench_effects_synth.jsonl --exclude results/svm_effects.v2.jsonl results/svm_effects_synth.jsonl
    .venv-mlx/bin/python -m src.aval_benchmark model --name tuned --adapter models/veto-svm-lora
    .venv-mlx/bin/python -m src.aval_benchmark model --name original
    python -m src.aval_benchmark prices
    python -m src.aval_benchmark report
"""
import argparse
import hashlib
import html
import json
import math
import random
import time
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from src import svm_dataset as sd
from src.eval_risk import parse_answer

OUT = Path("results/benchmark")
SEED = 20261009
N_CASES = 1000
MAINNET_SHARE = 0.4
WSOL = "So11111111111111111111111111111111111111112"

BLOCK, REVIEW, ALLOW = "BLOCK", "REVIEW", "ALLOW"
RANK = {ALLOW: 0, REVIEW: 1, BLOCK: 2}

LAYER_NAMES = {"A": "Camada A — Simulação + comparação determinística",
               "B": "Camada B — Detector de injeção",
               "C": "Camada C — IA de intenção"}

ATTACK_PT = {
    "recipient_mismatch": "Troca de destinatário",
    "amount_understated": "Valor declarado menor que o real",
    "asset_mismatch": "Ativo diferente do declarado",
    "approval_exceeds_intent": "Approve acima do declarado",
    "undeclared_approval": "Approve escondido",
    "undeclared_authority_change": "Troca de autoridade escondida",
    "undeclared_close": "Fechamento de conta escondido",
    "injected_instruction": "Prompt injection (modelos inéditos)",
}
ACTION_PT = {
    "transfer_sol": "Transferência de SOL", "transfer_token": "Transferência de token", "swap": "Swap",
    "approve": "Approve declarado", "set_authority": "SetAuthority declarado", "close": "Fechar conta",
    "create": "Criação de conta", "other": "Efeitos mistos (outros)",
}


# ---------- case building (pure) ----------

def select_usable(records, seed=42, min_sol=0.001, exclude=()):
    """[(record, honest intent)] with the same filters as ``svm_dataset.build`` (payer cap, size,
    derivable intent, --min-sol, clean honest label), after dropping digests in ``exclude``."""
    exclude = set(exclude)
    min_lamports = Decimal(str(min_sol)).scaleb(sd.SOL_DECIMALS)
    skipped = Counter()
    rank = lambda r: hashlib.sha256(f"{seed}:payer:{r.get('tx_digest')}".encode()).hexdigest()  # noqa: E731
    fresh, seen = [], set()
    for r in records:
        d = r.get("tx_digest")
        if d in exclude:
            skipped["in_training_data"] += 1
        elif d in seen:
            skipped["duplicate"] += 1
        else:
            seen.add(d)
            fresh.append(r)
    per_payer = defaultdict(list)
    for r in sorted(fresh, key=rank):
        per_payer[r.get("fee_payer")].append(r.get("tx_digest"))
    allowed = {d for ds in per_payer.values() for d in ds[:sd.MAX_RECORDS_PER_PAYER]}
    usable = []
    for r in fresh:
        if r.get("tx_digest") not in allowed:
            skipped["payer_cap"] += 1
            continue
        if sd._too_large(r):
            skipped["too_many_effects"] += 1
            continue
        intent = sd.derive_intent(r)
        if intent is None:
            skipped["no_derivable_intent"] += 1
            continue
        if intent["action"] == "transfer_sol" and sd.signer_view(r)["out"][sd.SOL] < min_lamports:
            skipped["below_min_sol"] += 1
            continue
        if sd.label(intent, r, {})[0]:
            skipped["honest_label_not_clean"] += 1
            continue
        usable.append((r, intent))
    return usable, dict(skipped)


def _natural_kinds(usable):
    return {kind for _, i in usable for kind, (prefix, primary) in sd.UNDECLARED.items()
            if i["action"] != primary and any(e.startswith(prefix) for e in i["allowed_effects"])}


def build_cases(mainnet, synthetic, n=N_CASES, mainnet_share=MAINNET_SHARE, seed=SEED):
    """One case per transaction, ~50/50 attack/legit. ``mainnet``/``synthetic``: [(record, intent)].

    The mainnet share is ``mainnet_share`` of ``n`` (or all usable mainnet records, if fewer); the
    rest is synthetic. A transaction is an attack when the attack count is not ahead and some
    mutation applies to it cleanly (its label is exactly that one signal); the least-used kind wins."""
    rng = random.Random(seed)
    m = sorted(mainnet, key=lambda x: x[0]["tx_digest"])
    s = sorted(synthetic, key=lambda x: x[0]["tx_digest"])
    rng.shuffle(m)
    rng.shuffle(s)
    n_main = min(len(m), round(n * mainnet_share))
    n_syn = min(len(s), n - n_main)
    if n_main + n_syn < n:
        n_main = min(len(m), n - n_syn)
    chosen = m[:n_main] + s[:n_syn]
    rng.shuffle(chosen)
    assets = [(i["asset"], i["decimals"]) for _, i in chosen if i["asset"]]
    twins = sd.twin_pool(chosen)
    natural = _natural_kinds(chosen)
    kinds_used = Counter()
    cases = []
    attacks = legit = 0
    for idx, (r, intent) in enumerate(chosen):
        field = rng.choice((None,) + sd.METADATA_FIELDS)
        metadata = {field: rng.choice(sd.BENIGN_TEXT[field])} if field else {}
        attack = None
        if attacks <= legit:
            options = []
            for kind in sd.MUTATIONS:
                out = sd.mutate(kind, intent, r, random.Random(f"{seed}:{r['tx_digest']}:{kind}"),
                                () if kind in natural else twins, metadata, sd.TEST_ONLY_INJECTIONS, assets)
                if out is None:
                    continue
                signals, reasons = sd.label(out[0], r, out[1])
                if signals == [kind]:
                    options.append((kinds_used[kind], rng.random(), kind, out, reasons))
            if options:
                options.sort(key=lambda o: (o[0], o[1]))
                _, _, kind, (m_intent, m_meta), reasons = options[0]
                twin = m_intent.pop("_twin", None)
                attack = {"kind": kind, "intent": m_intent, "metadata": m_meta, "reasons": reasons, "twin": twin}
        if attack:
            kinds_used[attack["kind"]] += 1
            attacks += 1
            case = {"intent": attack["intent"], "metadata": attack["metadata"], "expected": BLOCK,
                    "kind": attack["kind"], "gold_signals": [attack["kind"]], "gold_reasons": attack["reasons"]}
            if attack["twin"]:
                case["twin"] = attack["twin"]
        else:
            legit += 1
            case = {"intent": intent, "metadata": metadata, "expected": ALLOW,
                    "kind": "legit:" + intent["action"], "gold_signals": [], "gold_reasons": []}
        cases.append({"case_id": f"c{idx:04d}", "seed": seed, "tx_digest": r["tx_digest"],
                      "source": sd.source_of(r), "synth_case": r.get("case"), **case, "record": r})
    return cases


# ---------- pipeline (pure) ----------

def layer_a(case):
    """Signals from comparing the intent with the simulated effects (metadata not read)."""
    signals, reasons = sd.label(case["intent"], case["record"], {})
    return {"decision": BLOCK if signals else ALLOW, "signals": signals, "reasons": reasons}


def layer_b(case):
    for path, text in sd._metadata_texts(case.get("metadata") or {}):
        if sd.INJECTION_PATTERN.search(text):
            return {"decision": BLOCK, "signals": ["injected_instruction"], "reasons": [f"{path}: instrução ao revisor"]}
    return {"decision": ALLOW, "signals": [], "reasons": []}


def layer_c(pred):
    """Model answer (``parse_answer``) → decision. The model can only raise risk."""
    if pred is None or pred.get("risk") != "high":
        return {"decision": ALLOW, "signals": list((pred or {}).get("signals", [])),
                "invalid": (pred or {}).get("format") == "invalid"}
    sig = list(pred.get("signals", []))
    return {"decision": BLOCK if "injected_instruction" in sig else REVIEW, "signals": sig, "invalid": False}


def combine(layers):
    """{"A": {...}, "B": {...}, "C": {...}} (any subset) → (final decision, deciding layer or None)."""
    final, by = ALLOW, None
    for name in ("A", "B", "C"):
        d = layers.get(name, {}).get("decision", ALLOW)
        if RANK[d] > RANK[final]:
            final, by = d, name
    return final, by


def model_prompt(case):
    """System + user messages exactly as in training (risk format), without the answer."""
    ex = sd.to_chat(case["intent"], case["record"], case["metadata"], [], [], "risk")
    return ex["messages"][:2]


def confusion(rows, decide):
    """rows with "expected"; decide(row) → BLOCK/REVIEW/ALLOW. Positive = BLOCK."""
    tp = tn = fp = fn = 0
    for r in rows:
        blocked = decide(r) == BLOCK
        if r["expected"] == BLOCK:
            tp += blocked
            fn += not blocked
        else:
            fp += blocked
            tn += not blocked
    n = tp + tn + fp + fn
    ratio = lambda a, b: round(a / b, 4) if b else None  # noqa: E731
    return {"n": n, "tp": tp, "tn": tn, "fp": fp, "fn": fn, "accuracy": ratio(tp + tn, n),
            "precision": ratio(tp, tp + fp), "recall": ratio(tp, tp + fn), "fp_rate": ratio(fp, fp + tn)}


def percentile(values, q):
    """Nearest-rank percentile (q in 0..100); None for no values."""
    vals = sorted(values)
    if not vals:
        return None
    k = max(1, math.ceil(q / 100 * len(vals)))
    return vals[k - 1]


# ---------- value in USD (pure) ----------

def outflows(record):
    """{asset: (base units, decimals)} the signers lose in the simulation (fee excluded)."""
    v = sd.signer_view(record)
    return {a: (n, v["decimals"].get(a)) for a, n in v["out"].items() if n > 0}


def usd_value(record, prices):
    """(USD value or None, [assets without a price]). Synthetic records have no price at all."""
    if sd.source_of(record) != "mainnet":
        return None, ["synthetic"]
    total, missing = Decimal(0), []
    for asset, (n, dec) in outflows(record).items():
        key = WSOL if asset == sd.SOL else asset
        price = prices.get(key)
        if price is None or dec is None:
            missing.append(asset)
            continue
        total += Decimal(n).scaleb(-dec) * Decimal(str(price))
    return float(total), missing


def value_groups(rows, final_of):
    """Groups like the reference: attacks blocked/approved, legit approved/blocked (+ REVIEW)."""
    groups = {k: {"n": 0, "usd": 0.0, "priced": 0, "unpriced": 0, "partial": 0}
              for k in ("attack_blocked", "attack_review", "attack_allowed", "legit_allowed", "legit_review", "legit_blocked")}
    for r in rows:
        d = final_of(r)
        key = ("attack_" if r["expected"] == BLOCK else "legit_") + {BLOCK: "blocked", REVIEW: "review", ALLOW: "allowed"}[d]
        g = groups[key]
        g["n"] += 1
        if r["usd"] is None:
            g["unpriced"] += 1
        else:
            g["priced"] += 1
            g["usd"] += r["usd"]
            g["partial"] += bool(r["usd_missing"])
    return groups


# ---------- IO ----------

def read_jsonl(path):
    return list(sd.read_jsonl(path)) if Path(path).exists() else []


def write_jsonl(path, rows):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def cmd_cases(a):
    exclude = {r["tx_digest"] for p in a.exclude for r in sd.read_jsonl(p)}
    main_recs = [r for p in a.mainnet for r in sd.read_jsonl(p)]
    syn_recs = [r for p in a.synthetic for r in sd.read_jsonl(p)]
    m_usable, m_skip = select_usable(main_recs, a.seed, a.min_sol, exclude)
    s_usable, s_skip = select_usable(syn_recs, a.seed, a.min_sol, exclude)
    cases = build_cases(m_usable, s_usable, a.n, a.mainnet_share, a.seed)
    write_jsonl(OUT / "cases.jsonl", cases)
    meta = {"seed": a.seed, "n": len(cases), "min_sol": a.min_sol, "mainnet_share_target": a.mainnet_share,
            "exclude_files": a.exclude, "excluded_digests": len(exclude),
            "mainnet": {"records": len(main_recs), "usable": len(m_usable), "skipped": m_skip},
            "synthetic": {"records": len(syn_recs), "usable": len(s_usable), "skipped": s_skip},
            "by_source": dict(Counter(c["source"] for c in cases)),
            "by_expected": dict(Counter(c["expected"] for c in cases)),
            "by_kind": dict(Counter(c["kind"] for c in cases)),
            "by_source_expected": dict(Counter(f"{c['source']}:{c['expected']}" for c in cases)),
            "injections": "TEST_ONLY_INJECTIONS"}
    (OUT / "cases_meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(meta, indent=2, ensure_ascii=False))


def cmd_model(a):
    """Runs the model on every case (resumable): results/benchmark/model_<name>.jsonl."""
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    cases = read_jsonl(OUT / "cases.jsonl")
    out = OUT / f"model_{a.name}.jsonl"
    done = {r["case_id"] for r in read_jsonl(out)}
    model, tok = load(a.model, adapter_path=a.adapter)
    sampler = make_sampler(temp=0.0)
    with open(out, "a", encoding="utf-8") as f:
        for i, c in enumerate(cases):
            if c["case_id"] in done:
                continue
            prompt = tok.apply_chat_template(model_prompt(c), add_generation_prompt=True, tokenize=False)
            t0 = time.perf_counter()
            text = generate(model, tok, prompt=prompt, max_tokens=a.max_tokens, sampler=sampler, verbose=False)
            ms = (time.perf_counter() - t0) * 1000
            pred = parse_answer(text)
            f.write(json.dumps({"case_id": c["case_id"], "model": a.model, "adapter": a.adapter, "ms": round(ms, 1),
                                "pred": pred, "raw": text}, ensure_ascii=False) + "\n")
            f.flush()
            print(f"[{i + 1}/{len(cases)}] {c['case_id']} exp={c['expected']} risk={pred['risk']} {ms:.0f} ms", flush=True)


def cmd_prices(a):
    """CoinGecko (free public API, no key): SOL + every mainnet mint the cases move out, in two calls."""
    import urllib.parse
    import urllib.request

    cases = read_jsonl(OUT / "cases.jsonl")
    mints = sorted({m for c in cases if c["source"] == "mainnet" for m in outflows(c["record"]) if m != sd.SOL})
    base = "https://api.coingecko.com/api/v3"
    headers = {"accept": "application/json", "user-agent": "aval-benchmark"}

    def get(url):
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
            return json.loads(r.read())

    # Keyless /simple/token_price takes one contract per call; instead map mints → CoinGecko ids with
    # /coins/list (one call) and price every id in one /simple/price batch.
    prices, errors = {}, []
    listing = get(f"{base}/coins/list?include_platform=true")
    wanted = set(mints)
    ids, symbols = {}, {WSOL: "SOL"}
    for coin in listing:
        addr = (coin.get("platforms") or {}).get("solana")
        if addr in wanted:
            ids.setdefault(addr, coin["id"])
            symbols.setdefault(addr, (coin.get("symbol") or "").upper())
    batch = sorted(set(ids.values()) | {"solana"})
    got = get(f"{base}/simple/price?" + urllib.parse.urlencode({"ids": ",".join(batch), "vs_currencies": "usd"}))
    prices[WSOL] = got["solana"]["usd"]
    for mint, cid in ids.items():
        if got.get(cid, {}).get("usd") is not None:
            prices[mint] = got[cid]["usd"]
    unknown = sorted(wanted - set(ids))
    if unknown:
        errors.append(f"{len(unknown)} mints sem id na CoinGecko")
    out = {"fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"), "source": "CoinGecko public API",
           "mints_requested": len(mints) + 1, "prices": prices, "symbols": symbols, "errors": errors}
    (OUT / "prices.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ("fetched_at", "mints_requested", "errors")}, indent=1),
          f"\npriced: {len(prices)}")


# ---------- evaluation ----------

def evaluate(cases, tuned, original, prices, sim_us):
    """One row per case with each layer's verdict, latency and value."""
    rows = []
    for c in cases:
        t0 = time.perf_counter()
        a_ = layer_a(c)
        t1 = time.perf_counter()
        b_ = layer_b(c)
        t2 = time.perf_counter()
        tm = tuned.get(c["case_id"])
        om = original.get(c["case_id"])
        c_ = layer_c(tm["pred"] if tm else None)
        final, by = combine({"A": a_, "B": b_, "C": c_})
        ab, ab_by = combine({"A": a_, "B": b_})
        usd, missing = usd_value(c["record"], prices)
        sim = sim_us.get(c["tx_digest"])
        lat = {"A": (t1 - t0) * 1000, "B": (t2 - t1) * 1000, "C": tm["ms"] if tm else None,
               "sim": sim / 1000 if sim is not None else None}
        rows.append({"case_id": c["case_id"], "tx_digest": c["tx_digest"], "source": c["source"],
                     "synth_case": c.get("synth_case"), "kind": c["kind"], "expected": c["expected"],
                     "intent_action": c["intent"]["action"], "A": a_, "B": b_, "C": c_,
                     "tuned": tm["pred"] if tm else None, "original": om["pred"] if om else None,
                     "infra_error": tm is None, "final": final, "decided_by": by, "ab": ab, "ab_by": ab_by,
                     "lat": lat, "usd": usd, "usd_missing": missing, "gold_reasons": c.get("gold_reasons", []),
                     "metadata": c.get("metadata", {})})
    return rows


def _model_decision(pred):
    return BLOCK if pred and pred.get("risk") == "high" else ALLOW


BASELINES = (
    ("always_allow", "Baseline always_allow", lambda r: ALLOW),
    ("always_block", "Baseline always_block", lambda r: BLOCK),
    ("model_only_original", "Só a IA original (bf16 de Luis, high→BLOCK)", lambda r: _model_decision(r["original"])),
    ("model_only_tuned", "Só a IA ajustada (LoRA iter 300, high→BLOCK)", lambda r: _model_decision(r["tuned"])),
    ("pipeline_without_model", "Pipeline sem IA (A + B)", lambda r: r["ab"]),
    ("full_pipeline", "Pipeline completo (A + B + C)", lambda r: r["final"]),
    ("full_pipeline_review_as_block", "Pipeline completo, REVIEW contado como BLOCK",
     lambda r: BLOCK if r["final"] in (BLOCK, REVIEW) else ALLOW),
)


def summarize(rows, prices_meta, cases_meta):
    s = {"n": len(rows), "baselines": {}, "by_source": {}}
    for key, label_, fn in BASELINES:
        s["baselines"][key] = {"label": label_, **confusion(rows, fn)}
        s["by_source"][key] = {src: confusion([r for r in rows if r["source"] == src], fn) for src in ("mainnet", "synthetic")}
    s["final_counts"] = {exp: dict(Counter(r["final"] for r in rows if r["expected"] == exp)) for exp in (BLOCK, ALLOW)}
    s["value"] = value_groups(rows, lambda r: r["final"])
    s["decided_by"] = dict(Counter(r["decided_by"] or "—" for r in rows))
    s["infra_errors"] = sum(r["infra_error"] for r in rows)
    s["tuned_invalid"] = sum(bool(r["tuned"]) and r["tuned"]["format"] == "invalid" for r in rows)
    s["original_invalid"] = sum(bool(r["original"]) and r["original"]["format"] == "invalid" for r in rows)
    lat = {}
    for k in ("A", "B", "C", "sim"):
        vals = [r["lat"][k] for r in rows if r["lat"][k] is not None]
        lat[k] = {"n": len(vals), "p50": percentile(vals, 50), "p95": percentile(vals, 95),
                  "mean": sum(vals) / len(vals) if vals else None}
    tot = [r["lat"]["A"] + r["lat"]["B"] + (r["lat"]["C"] or 0) + (r["lat"]["sim"] or 0) for r in rows]
    lat["total"] = {"n": len(tot), "p50": percentile(tot, 50), "p95": percentile(tot, 95), "mean": sum(tot) / len(tot)}
    s["latency"] = lat
    s["prices"] = prices_meta
    s["cases_meta"] = cases_meta
    return s


# ---------- report (HTML) ----------

def _pct(x, digits=1):
    return "—" if x is None else f"{x * 100:.{digits}f}%"


def _usd(x):
    if x is None:
        return "sem cotação"
    s = f"{x:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"US$ {s}"


def _ms(x):
    if x is None:
        return "—"
    if x < 0.1:
        return f"{x * 1000:.0f} µs"
    if x < 10:
        return f"{x:.2f} ms".replace(".", ",")
    return f"{x:,.0f} ms".replace(",", ".")


def _num(x):
    return "—" if x is None else f"{x:.4f}"


def _e(x):
    return html.escape(str(x))


def card(value, label, color=""):
    return f'<div class="card"><div class="big {color}">{_e(value)}</div><div class="lbl">{_e(label)}</div></div>'


def table(head, body, cls=""):
    th = "".join(f"<th>{h}</th>" for h in head)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in body)
    return f'<table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>'


def _type_name(kind):
    if kind.startswith("legit:"):
        return ACTION_PT.get(kind[6:], kind[6:])
    return ATTACK_PT.get(kind, kind)


def _why(r):
    """What stopped the case, or the outcome."""
    if r["final"] == ALLOW:
        return "Aprovado"
    if r["final"] == REVIEW:
        return "REVIEW: IA marcou risco alto (" + (", ".join(r["C"]["signals"]) or "sem sinal") + ")"
    layer = r["decided_by"]
    if layer == "A":
        return "Camada A: " + ", ".join(r["A"]["signals"])
    if layer == "B":
        return "Camada B: injeção nos metadados"
    return "Camada C: IA high + injected_instruction"


def render(rows, s):
    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    cm = s["cases_meta"]
    n_att = sum(r["expected"] == BLOCK for r in rows)
    n_leg = len(rows) - n_att
    fc = s["final_counts"]
    blocked = sum(r["final"] == BLOCK for r in rows)
    allowed = sum(r["final"] == ALLOW for r in rows)
    review = sum(r["final"] == REVIEW for r in rows)
    usd_of = lambda pred: sum(r["usd"] or 0 for r in rows if pred(r))  # noqa: E731
    fp = s["baselines"]["full_pipeline"]
    v = s["value"]
    src = Counter(r["source"] for r in rows)
    parts = []
    P = parts.append
    P(f"<h1>Relatório AVAL — Benchmark Solana (1000 transações)</h1>"
      f'<div class="sub">Gerado em {now} · {len(rows)} casos · seed {cm["seed"]} · {src["mainnet"]} mainnet / '
      f'{src["synthetic"]} sintéticas · modelo: base bf16 de Luis + LoRA veto-svm iter 300 (guloso)</div>')

    # Decisions
    P("<h2>Decisões: BLOCK x ALLOW</h2><div class='cards'>")
    P(card(blocked, f"BLOCK · {_usd(usd_of(lambda r: r['final'] == BLOCK))} (só mainnet com cotação)", "red"))
    P(card(allowed, f"ALLOW · {_usd(usd_of(lambda r: r['final'] == ALLOW))}", "green"))
    P(card(f"{n_att} / {n_leg}", "esperado BLOCK / ALLOW"))
    P("</div>")
    body = []
    for exp, name in ((BLOCK, "Ataques (deveriam ser BLOCK)"), (ALLOW, "Legítimas (deveriam ser ALLOW)")):
        c = fc.get(exp, {})
        good_b, good_a = (exp == BLOCK), (exp == ALLOW)
        body.append([f"<b>{name}</b>", sum(c.values()),
                     f'<span class="{"green" if good_b else "red"}">{c.get(BLOCK, 0)}</span>',
                     f'<span class="{"green" if good_a else "red"}">{c.get(ALLOW, 0)}</span>', c.get(REVIEW, 0)])
    body.append(["<b>Total</b>", len(rows), f"<b>{blocked}</b>", f"<b>{allowed}</b>", review])
    P(table(["", "Casos", "Obtido BLOCK", "Obtido ALLOW", "REVIEW (outros)"], body))

    # Value
    P("<h3>Valor das transações</h3><div class='cards'>")
    P(card(_usd(v["attack_blocked"]["usd"]), "salvo: ataques bloqueados", "green"))
    P(card(_usd(v["attack_allowed"]["usd"]), "teria sido roubado: ataques aprovados", "red"))
    P(card(_usd(v["legit_blocked"]["usd"]), "legítimo bloqueado indevidamente", "red"))
    P("</div>")
    groups = (("attack_blocked", "Ataques bloqueados", "valor protegido"),
              ("attack_review", "Ataques em REVIEW", "retido para revisão humana"),
              ("attack_allowed", "Ataques aprovados", "valor que teria sido roubado"),
              ("legit_allowed", "Legítimas aprovadas", "operação normal"),
              ("legit_review", "Legítimas em REVIEW", "atrasado para revisão humana"),
              ("legit_blocked", "Legítimas bloqueadas", "valor travado indevidamente (falso positivo)"))
    P(table(["Grupo", "Transações", "Valor (US$)", "Com cotação / sem cotação", "Significado"],
            [[g, v[k]["n"], _usd(v[k]["usd"]) if v[k]["priced"] or not v[k]["n"] else "sem cotação",
              f"{v[k]['priced']} / {v[k]['unpriced']}", m] for k, g, m in groups]))
    pr = s["prices"]
    sol_price = pr.get("prices", {}).get(WSOL)
    priced_mints = len(pr.get("prices", {})) - 1
    partial = sum(v[k]["partial"] for k in v)
    syms = pr.get("symbols", {})
    quotes = ", ".join(f"{_e(syms.get(k, k[:6]))} US$ {p_:g}" for k, p_ in sorted(pr.get("prices", {}).items(), key=lambda x: -x[1]))
    P(f"<p class='note'>Cotações: {quotes}.</p>")
    P(f"<p class='note'>Valor = o que sai das contas do signatário na simulação (SOL + tokens, sem a taxa), na "
      f"cotação CoinGecko de {_e(pr.get('fetched_at', '—'))} (SOL US$ {sol_price}; {priced_mints} de "
      f"{pr.get('mints_requested', 1) - 1} mints da mainnet com cotação; {partial} transações mainnet têm algum "
      f"token sem cotação, contado como US$ 0). As {src['synthetic']} transações sintéticas usam mints criados na VM local, "
      f"sem preço: aparecem como <b>sem cotação</b>, não são estimadas. Nada é assinado ou enviado.</p>")

    # Summary
    P("<h2>Resumo geral</h2><div class='cards'>")
    P(card(_pct(fp["accuracy"]), "acurácia do pipeline (REVIEW conta como não-BLOCK)"))
    P(card(f"{fp['tp']}/{n_att}", f"ataques bloqueados ({_pct(fp['recall'])})", "green"))
    P(card(fp["fn"], "ataques não bloqueados", "red" if fp["fn"] else "green"))
    P(card(fp["fp"], f"falsos positivos finais (taxa {_pct(fp['fp_rate'])})", "red" if fp["fp"] else "green"))
    P(card(review, f"REVIEW ({fc.get(BLOCK, {}).get(REVIEW, 0)} ataques, {fc.get(ALLOW, {}).get(REVIEW, 0)} legítimas)"))
    P(card(s["infra_errors"], f"erros de infraestrutura ({s['tuned_invalid']} respostas inválidas da IA)"))
    P("</div>")

    # Per type
    P("<h3>Por tipo de ataque</h3>")
    by_kind = defaultdict(list)
    for r in rows:
        by_kind[r["kind"]].append(r)
    order = [k for k in sd.MUTATIONS if k in by_kind] + sorted(k for k in by_kind if k.startswith("legit:"))
    body = []
    for k in order:
        rs = by_kind[k]
        exp = rs[0]["expected"]
        ok = sum((r["final"] == BLOCK) == (exp == BLOCK) for r in rs)
        whys = Counter(_why(r) for r in rs)
        why = "<br>".join(f"{_e(w)} <small>({n})</small>" for w, n in whys.most_common())
        lat = [r["lat"]["A"] + r["lat"]["B"] + (r["lat"]["C"] or 0) + (r["lat"]["sim"] or 0) for r in rs]
        srcs = Counter(r["source"] for r in rs)
        rate = ok / len(rs)
        body.append([_e(_type_name(k)), "Ataque" if exp == BLOCK else "Legítimo",
                     f"{len(rs)}<br><small>{srcs['mainnet']} main / {srcs['synthetic']} sint.</small>", ok, len(rs) - ok,
                     f"{_pct(rate)}<div class='bar'><span style='width:{rate * 100:.0f}%'></span></div>", why,
                     _ms(sum(lat) / len(lat))])
    P(table(["Tipo", "Classe", "Casos", "Corretos", "Erros", "Taxa de acerto", "O que impediu / resultado", "Latência média"],
            body, "types"))
    P("<p class='note'>Latência média = A + B + IA + simulação (simulação medida só nas sintéticas; ver Latência).</p>")

    # Per layer
    P("<h2>Por camada</h2>")
    body = []
    for name in ("A", "B", "C"):
        att = [r for r in rows if r["expected"] == BLOCK]
        leg = [r for r in rows if r["expected"] == ALLOW]
        hit = lambda r: r[name]["decision"] != ALLOW  # noqa: E731
        only = sum(hit(r) and all(r[o]["decision"] == ALLOW for o in "ABC" if o != name) for r in att)
        first = s["decided_by"].get(name, 0)
        body.append([LAYER_NAMES[name], sum(r[name]["decision"] == BLOCK for r in att),
                     sum(r[name]["decision"] == REVIEW for r in att), sum(r[name]["decision"] == BLOCK for r in leg),
                     sum(r[name]["decision"] == REVIEW for r in leg), first, only])
    P(table(["Camada", "Ataques: BLOCK", "Ataques: REVIEW", "Legítimas: BLOCK", "Legítimas: REVIEW",
             "Decidiu primeiro (A→B→C)", "Ataques que só ela pegou"], body))
    P("<p class='note'>Regra “o LLM opina, o código decide”: a IA só aumenta o risco. IA <i>high</i> com "
      "<code>injected_instruction</code> → BLOCK; <i>high</i> só com outros sinais → REVIEW (contado à parte, não é "
      "BLOCK); IA <i>low</i> nunca derruba um BLOCK de A ou B.</p>")
    # IA per signal (non-circular measure)
    P("<h3>IA de intenção por sinal (medida não circular)</h3>")
    body = []
    for k in order:
        rs = by_kind[k]
        exp = rs[0]["expected"]
        t_hi = sum(bool(r["tuned"]) and r["tuned"]["risk"] == "high" for r in rs)
        t_named = sum(bool(r["tuned"]) and (k in r["tuned"]["signals"]) for r in rs) if exp == BLOCK else None
        o_hi = sum(bool(r["original"]) and r["original"]["risk"] == "high" for r in rs)
        good = (lambda x: x) if exp == BLOCK else (lambda x: len(rs) - x)
        body.append([_e(_type_name(k)), len(rs), f"{good(t_hi)} ({_pct(good(t_hi) / len(rs))})",
                     "—" if t_named is None else f"{t_named} ({_pct(t_named / len(rs))})",
                     f"{good(o_hi)} ({_pct(good(o_hi) / len(rs))})"])
    P(table(["Tipo", "Casos", "IA ajustada: acertos", "IA ajustada: nomeou o sinal", "IA original: acertos"], body))

    # Baselines
    P("<h2>Baselines</h2>")
    body = []
    for key, label_, _ in BASELINES:
        b = s["baselines"][key]
        body.append([_e(label_), b["n"], b["tp"], b["tn"], b["fp"], b["fn"], _num(b["accuracy"]), _num(b["precision"]),
                     _num(b["recall"]), _num(b["fp_rate"])])
    P(table(["Conjunto", "Casos", "VP", "VN", "FP", "FN", "Acurácia", "Precisão", "Recall", "Taxa FP"], body))
    P("<h3>Por origem</h3>")
    body = []
    for key in ("model_only_original", "model_only_tuned", "pipeline_without_model", "full_pipeline"):
        for so in ("mainnet", "synthetic"):
            b = s["by_source"][key][so]
            body.append([_e(s["baselines"][key]["label"]), so, b["n"], b["tp"], b["tn"], b["fp"], b["fn"], _num(b["accuracy"]),
                         _num(b["precision"]), _num(b["recall"]), _num(b["fp_rate"])])
    P(table(["Conjunto", "Origem", "Casos", "VP", "VN", "FP", "FN", "Acurácia", "Precisão", "Recall", "Taxa FP"], body))
    P(f"<p class='note'>Positivo = BLOCK. REVIEW conta como não-BLOCK, exceto na última linha. Respostas inválidas da IA "
      f"contam como ALLOW (ajustada: {s['tuned_invalid']}, original: {s['original_invalid']}).</p>")

    # Latency
    P("<h2>Latência</h2>")
    L = s["latency"]
    body = [[name, L[k]["n"], _ms(L[k]["p50"]), _ms(L[k]["p95"]), _ms(L[k]["mean"])] for k, name in
            (("sim", "Simulação aval-svm (sintéticas, estado em memória)"), ("A", LAYER_NAMES["A"] + " (código)"),
             ("B", LAYER_NAMES["B"] + " (código)"), ("C", LAYER_NAMES["C"] + " (MLX, Apple M4 Pro)"),
             ("total", "Total por caso"))]
    P(table(["Camada", "Casos medidos", "p50", "p95", "Média"], body))
    P("<p class='note'>A simulação das sintéticas foi refeita pelo motor do aval-svm (LiteSVM, programas SPL reais, "
      "estado em memória, sem rede) e cronometrada por transação. A latência de simulação das transações da mainnet não "
      "pode ser medida numa reexecução “quente”: o estado on-chain já mudou desde a amostragem, então não é reportada. "
      "A e B são código Python puro; C é a chamada do modelo (geração gulosa, até 200 tokens).</p>")

    # Errors list
    P("<h2>Casos não detectados e falsos positivos</h2>")
    fns = [r for r in rows if r["expected"] == BLOCK and r["final"] != BLOCK]
    fps = [r for r in rows if r["expected"] == ALLOW and r["final"] != ALLOW]
    P(f"<div class='cards'>{card(len(fns), 'ataques não bloqueados (BLOCK)', 'red' if fns else 'green')}"
      f"{card(sum(r['final'] == BLOCK for r in fps), 'legítimas bloqueadas', 'red' if any(r['final'] == BLOCK for r in fps) else 'green')}"
      f"{card(sum(r['final'] == REVIEW for r in fps), 'legítimas em REVIEW')}</div>")

    def err_rows(rs, attack):
        out = []
        for r in rs:
            if attack:
                reason = (f"A e B sem sinal; IA: {r['tuned']['risk'] if r['tuned'] else 'sem resposta'} "
                          f"{r['C']['signals'] or ''}")
                if r["final"] == REVIEW:
                    reason = "Ficou em REVIEW (IA high sem injected_instruction); A e B sem sinal"
            else:
                reason = _why(r)
            meta = "; ".join(f"{k}: {str(x)[:60]}" for k, x in (r.get("metadata") or {}).items())
            out.append([r["case_id"], _e(_type_name(r["kind"])), r["source"], f"<code>{_e(r['tx_digest'][:16])}</code>",
                        r["final"], _e(reason) + (f"<br><small>metadados: {_e(meta)}</small>" if meta else "")])
        return out

    P("<h3>Ataques não bloqueados</h3>")
    P(table(["Caso", "Tipo", "Origem", "Digest", "Final", "Motivo"], err_rows(fns, True)) if fns else "<p>Nenhum.</p>")
    P("<h3>Legítimas não aprovadas (falsos positivos e REVIEW)</h3>")
    P(table(["Caso", "Tipo", "Origem", "Digest", "Final", "Motivo"], err_rows(fps, False)) if fps else "<p>Nenhum.</p>")
    t_err = Counter(_type_name(r["kind"]) for r in rows if _model_decision(r["tuned"]) != r["expected"])
    P("<h3>Erros da IA ajustada sozinha, por tipo</h3>")
    P(table(["Tipo", "Erros"], [[_e(k), n] for k, n in t_err.most_common()]) if t_err else "<p>Nenhum.</p>")

    # How to read
    m, sy = cm["mainnet"], cm["synthetic"]
    P("<h2>Como ler estes números</h2><ul class='read'>")
    P("<li><b>A Camada A é circular por construção.</b> Os rótulos dos ataques de intenção x efeito são produzidos pela "
      "mesma lógica de comparação (<code>label()</code>) que a Camada A executa. Os acertos dela nesses casos mostram o "
      "mecanismo funcionando de ponta a ponta em transações reais simuladas — não são habilidade independente de "
      "detecção. O mesmo vale para a Camada B: o detector de injeção usa o mesmo padrão que rotulou os casos.</li>")
    P("<li><b>A IA é a medida não circular.</b> As colunas “Só a IA” e a tabela por sinal mostram o que o modelo "
      "acerta sozinho, sem ver o rótulo; é aí que se mede habilidade.</li>")
    P(f"<li><b>Dados novos.</b> {m['records']} transações mainnet coletadas agora (blocos finalizados recentes), "
      f"removidas as que estavam no treino ({m['skipped'].get('in_training_data', 0)}); {m['usable']} passaram nos "
      f"filtros do dataset (teto por pagador, --min-sol {cm['min_sol']}, intenção derivável). {sy['records']} "
      f"sintéticas com seed 777 (treino usou 42). Uma transação = um caso.</li>")
    P("<li><b>Injeções inéditas.</b> Os casos de prompt injection usam só os 10 modelos reservados para teste "
      "(<code>TEST_ONLY_INJECTIONS</code>), nunca vistos no treino.</li>")
    P("<li><b>Sintéticas</b> são construídas na VM local (LiteSVM) com os programas SPL Token / Token-2022 reais; "
      "cobrem approve, set_authority e close, raros numa amostra da mainnet. São mais fáceis que as da mainnet.</li>")
    P("<li><b>Nada foi assinado nem enviado.</b> Tudo é simulação; custo zero.</li>")
    P("<li><b>REVIEW</b> não é BLOCK: é a IA levantando risco sem que o código confirme. Fica fora de VP/FP, "
      "exceto na linha “REVIEW contado como BLOCK”.</li>")
    P("</ul>")
    return PAGE.replace("{{BODY}}", "\n".join(parts))


PAGE = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório AVAL Solana</title>
<style>
:root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--green:#1a7f4b;--red:#b42318;--blue:#2b59c3}
body{background:#fff;color:var(--ink);font-family:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
 font-size:13px;line-height:1.45;margin:0}
main{max-width:900px;margin:0 auto;padding:28px 16px}
h1{font-size:28px;margin:0 0 6px}
.sub{color:var(--muted);padding-bottom:18px;border-bottom:3px solid var(--ink);margin-bottom:26px}
h2{font-size:21px;margin:30px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line);break-after:avoid}
h3{font-size:15px;margin:22px 0 10px;break-after:avoid}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0}
.card{border:1px solid #d9dce1;border-radius:6px;padding:14px 16px;break-inside:avoid}
.big{font-size:26px;font-weight:700;line-height:1.2}
.lbl{color:var(--muted);margin-top:4px}
.green{color:var(--green)} .red{color:var(--red)}
table{width:100%;border-collapse:collapse;margin:10px 0}
th{text-align:left;font-weight:600;padding:8px 10px;border-bottom:1px solid #d1d5db;vertical-align:bottom}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr{break-inside:avoid}
small{color:var(--muted);font-size:10px}
.bar{height:4px;background:#e5e7eb;border-radius:2px;margin-top:4px;width:70px}
.bar span{display:block;height:4px;background:var(--blue);border-radius:2px}
.note{color:var(--muted);font-size:12px}
code{font-family:Consolas,Menlo,monospace;font-size:11px}
.read li{margin:6px 0}
@media (max-width:640px){.cards{grid-template-columns:1fr}table{font-size:11px}}
</style></head><body><main>
{{BODY}}
</main></body></html>"""


def cmd_report(a):
    cases = read_jsonl(OUT / "cases.jsonl")
    tuned = {r["case_id"]: r for r in read_jsonl(OUT / "model_tuned.jsonl")}
    original = {r["case_id"]: r for r in read_jsonl(OUT / "model_original.jsonl")}
    prices_meta = json.loads((OUT / "prices.json").read_text()) if (OUT / "prices.json").exists() else {"prices": {}}
    sim_us = {r["tx_digest"]: r["sim_us"] for r in read_jsonl(a.timings)}
    cases_meta = json.loads((OUT / "cases_meta.json").read_text())
    rows = evaluate(cases, tuned, original, prices_meta.get("prices", {}), sim_us)
    s = summarize(rows, prices_meta, cases_meta)
    write_jsonl(OUT / "rows.jsonl", rows)
    (OUT / "summary.json").write_text(json.dumps(s, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "relatorio_aval_1000.html").write_text(render(rows, s), encoding="utf-8")
    print(json.dumps({k: {x: s["baselines"][k][x] for x in ("tp", "tn", "fp", "fn", "accuracy")} for k in s["baselines"]}, indent=1))
    print(json.dumps(s["value"], indent=1), json.dumps(s["latency"], indent=1))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cases")
    c.add_argument("--mainnet", nargs="+", required=True)
    c.add_argument("--synthetic", nargs="+", required=True)
    c.add_argument("--exclude", nargs="*", default=[])
    c.add_argument("--seed", type=int, default=SEED)
    c.add_argument("--n", type=int, default=N_CASES)
    c.add_argument("--mainnet-share", type=float, default=MAINNET_SHARE)
    c.add_argument("--min-sol", type=float, default=0.001)
    m = sub.add_parser("model")
    m.add_argument("--name", required=True)
    m.add_argument("--model", default="models/veto-merged-bf16")
    m.add_argument("--adapter")
    m.add_argument("--max-tokens", type=int, default=200)
    pr = sub.add_parser("prices")
    r = sub.add_parser("report")
    r.add_argument("--timings", default=str(OUT / "synth_sim_timings.jsonl"))
    a = p.parse_args(argv)
    {"cases": cmd_cases, "model": cmd_model, "prices": cmd_prices, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
