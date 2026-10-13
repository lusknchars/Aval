"""Benchmark Aval 20k em streaming: tráfego real da mainnet + suíte de ataques, eventos ao vivo.

Três conjuntos (``set``), nunca misturados nos números de destaque:

* ``real_traffic`` — cada registro mainnet utilizável vira UM caso honesto (esperado ALLOW).
  Teto de 20 casos por pagador; ``--min-sol`` descarta transfer_sol de poeira.
* ``attack_real_tx`` — "transação real, intenção forjada": 2.000 registros mainnet sorteados
  (hash com seed, ANTES de virarem casos honestos; conjuntos disjuntos), cada um com UMA mutação
  (esperado BLOCK).
* ``attack_constructed`` — ``aval-svm dataset-synth --count 4000 --seed 9001``: cada transação dá
  um caso mutado (BLOCK) e o seu gêmeo honesto (ALLOW).

Injeções só de ``TEST_ONLY_INJECTIONS``. Tudo é determinístico e retomável: o construtor de casos
re-lê os efeitos do início e só acrescenta ``case_id`` novos; o executor pula casos já com evento.

    python -m src.bench20k cases --follow           # results/bench20k/cases.jsonl (incremental)
    python -m src.aval_benchmark --stream --follow  # eventos A/B + summary.json a cada 500 eventos
    .venv-mlx/bin/python -m src.bench20k model --follow           # IA ajustada (iter 300)
    .venv-mlx/bin/python -m src.bench20k baseline                 # IA original, amostra de 2.000
    python -m src.bench20k prices | report
"""
import argparse
import fcntl
import hashlib
import json
import os
import random
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from src import aval_benchmark as ab
from src import svm_dataset as sd

OUT = Path("results/bench20k")
MAINNET = Path("results/bench20k_effects_mainnet.jsonl")
SYNTH = OUT / "synth_effects.jsonl"
EXCLUDE = ("results/svm_effects.jsonl", "results/svm_effects.v2.jsonl", "results/bench_effects_mainnet.jsonl",
           "results/bench_effects_mainnet.v2.jsonl", "results/svm_effects_synth.jsonl", "results/bench_effects_synth.jsonl")
DONE_MARKER = "collection_done"   # the collector script touches it after the backfill
CASES_DONE = "cases_done"         # the case builder touches it once every record is turned into cases
SEED = 20261010
PER_PAYER = 20
N_ATTACK_REAL = 2000
P_ATTACK_REAL = 0.10
# Constructed cases are interleaved with mainnet ones (one per this many usable mainnet records)
# so the live totals of every set grow together; the rest is flushed at the end.
CONSTRUCTED_EVERY = 3
SUMMARY_EVERY = 500
SETS = ("real_traffic", "attack_real_tx", "attack_constructed")
BLOCK, REVIEW, ALLOW = ab.BLOCK, ab.REVIEW, ab.ALLOW
MODEL_POLICY = "model_policy.json"


def load_policy(out):
    """Model sampling policy written by the model worker when it falls behind (None = every case)."""
    try:
        return json.loads((Path(out) / MODEL_POLICY).read_text())
    except (OSError, ValueError):
        return None


def model_wanted(case_id, set_, policy):
    """Whether the model scores this case: all of them, or a seeded per-set sample under a policy."""
    if not policy:
        return True
    return _h(policy["seed"], "model", case_id) < policy["sample"].get(set_, 1.0)


def _h(seed, *parts):
    return int(hashlib.sha256(":".join(map(str, (seed,) + parts)).encode()).hexdigest()[:12], 16) / 16 ** 12


def _metadata(rng):
    field = rng.choice((None,) + sd.METADATA_FIELDS)
    return {field: rng.choice(sd.BENIGN_TEXT[field])} if field else {}


def _usable(r, min_lamports):
    """(intent, None) or (None, skip reason) with the dataset's filters (payer cap applied by the caller)."""
    if sd._too_large(r):
        return None, "too_many_effects"
    intent = sd.derive_intent(r)
    if intent is None:
        return None, "no_derivable_intent"
    if intent["action"] == "transfer_sol" and sd.signer_view(r)["out"][sd.SOL] < min_lamports:
        return None, "below_min_sol"
    if sd.label(intent, r, {})[0]:
        return None, "honest_label_not_clean"
    return intent, None


def pick_mutation(r, intent, metadata, seed, kinds_used, twins, natural, assets, group=None):
    """Least-used mutation (overall, or within ``group``) whose label is exactly that signal, or None."""
    options = []
    for kind in sd.MUTATIONS:
        out = sd.mutate(kind, intent, r, random.Random(f"{seed}:{r['tx_digest']}:{kind}"),
                        () if kind in natural else twins, metadata, sd.TEST_ONLY_INJECTIONS, assets)
        if out is None:
            continue
        signals, reasons = sd.label(out[0], r, out[1])
        if signals == [kind]:
            used = (group or kinds_used)[kind]
            options.append((used, _h(seed, "tie", r["tx_digest"], kind), kind, out, reasons))
    if not options:
        return None
    options.sort(key=lambda o: (o[0], o[1]))
    _, _, kind, (m_intent, m_meta), reasons = options[0]
    twin = m_intent.pop("_twin", None)
    return {"kind": kind, "intent": m_intent, "metadata": m_meta, "reasons": reasons, "twin": twin}


def _case(case_id, set_, r, intent, metadata, attack=None):
    base = {"case_id": case_id, "set": set_, "seed": SEED, "tx_digest": r["tx_digest"], "source": sd.source_of(r),
            "synth_case": r.get("case")}
    if attack:
        c = {**base, "intent": attack["intent"], "metadata": attack["metadata"], "expected": BLOCK, "kind": attack["kind"],
             "gold_signals": [attack["kind"]], "gold_reasons": attack["reasons"]}
        if attack["twin"]:
            c["twin"] = attack["twin"]
    else:
        c = {**base, "intent": intent, "metadata": metadata, "expected": ALLOW, "kind": "legit:" + intent["action"],
             "gold_signals": [], "gold_reasons": []}
    c["record"] = r
    return c


def constructed_cases(records, seed=SEED, min_sol=0.001):
    """Each synthetic record → its benign twin (ALLOW) and one mutation (BLOCK), in file order."""
    min_lamports = Decimal(str(min_sol)).scaleb(sd.SOL_DECIMALS)
    usable, skipped, seen = [], Counter(), set()
    for r in records:
        if r["tx_digest"] in seen:
            skipped["duplicate"] += 1
            continue
        seen.add(r["tx_digest"])
        intent, why = _usable(r, min_lamports)
        if why:
            skipped[why] += 1
        else:
            usable.append((r, intent))
    twins = sd.twin_pool(usable)
    natural = ab._natural_kinds(usable)
    assets = [(i["asset"], i["decimals"]) for _, i in usable if i["asset"]]
    kinds, out = Counter(), []
    no_mutation = 0
    for r, intent in usable:
        d16 = r["tx_digest"][:16]
        metadata = _metadata(random.Random(f"{seed}:meta:{r['tx_digest']}"))
        out.append(_case(f"ac-{d16}-benign", "attack_constructed", r, intent, metadata))
        attack = pick_mutation(r, intent, metadata, seed, kinds, twins, natural, assets)
        if attack is None:
            no_mutation += 1
            continue
        kinds[attack["kind"]] += 1
        out.append(_case(f"ac-{d16}-attack", "attack_constructed", r, intent, metadata, attack))
    return out, {"records": len(records), "usable": len(usable), "skipped": dict(skipped), "no_mutation": no_mutation,
                 "by_kind": dict(kinds)}


class MainnetBuilder:
    """Replays mainnet records in file order; each call to ``add`` returns the cases for one record.

    Pools (twins, assets, natural kinds) only hold records seen BEFORE the current one, so a replay
    of the same file gives the same cases (resumable, stable ``case_id``)."""

    def __init__(self, exclude=(), seed=SEED, min_sol=0.001, per_payer=PER_PAYER, n_attack=N_ATTACK_REAL, p_attack=P_ATTACK_REAL):
        self.exclude, self.seed, self.per_payer, self.n_attack, self.p_attack = set(exclude), seed, per_payer, n_attack, p_attack
        self.min_lamports = Decimal(str(min_sol)).scaleb(sd.SOL_DECIMALS)
        self.min_sol = min_sol
        self.seen, self.payers, self.skipped = set(), Counter(), Counter()
        self.usable, self.assets, self.natural = [], [], set()
        self.kinds = Counter()
        self.records = self.attacks = self.honest = self.selected_no_mutation = 0

    def add(self, r):
        self.records += 1
        d = r.get("tx_digest")
        if not d or d in self.exclude:
            self.skipped["in_earlier_files"] += 1
            return []
        if d in self.seen:
            self.skipped["duplicate"] += 1
            return []
        self.seen.add(d)
        intent, why = _usable(r, self.min_lamports)
        if why:
            self.skipped[why] += 1
            return []
        payer = r.get("fee_payer")
        if self.payers[payer] >= self.per_payer:
            self.skipped["payer_cap"] += 1
            return []
        self.payers[payer] += 1
        metadata = _metadata(random.Random(f"{self.seed}:meta:{d}"))
        case = None
        # The attack draw comes first: a record picked here never becomes an honest case.
        if self.attacks < self.n_attack and _h(self.seed, "attack", d) < self.p_attack:
            twins = sd.twin_pool(self.usable)
            attack = pick_mutation(r, intent, metadata, self.seed, self.kinds, twins, self.natural, self.assets)
            if attack:
                self.kinds[attack["kind"]] += 1
                self.attacks += 1
                case = _case(f"ar-{d[:16]}", "attack_real_tx", r, intent, metadata, attack)
            else:
                self.selected_no_mutation += 1
        if case is None:
            self.honest += 1
            case = _case(f"rt-{d[:16]}", "real_traffic", r, intent, metadata)
        self.usable.append((r, intent))
        if intent["asset"]:
            self.assets.append((intent["asset"], intent["decimals"]))
        self.natural |= ab._natural_kinds([(r, intent)])
        return [case]

    def meta(self):
        return {"records": self.records, "usable": len(self.usable), "skipped": dict(self.skipped),
                "payer_cap": self.per_payer, "payer_cap_dropped": self.skipped.get("payer_cap", 0),
                "payers": len(self.payers), "real_traffic": self.honest, "attack_real_tx": self.attacks,
                "attack_real_tx_target": self.n_attack, "attack_draw_p": self.p_attack,
                "attack_draw_without_clean_mutation": self.selected_no_mutation, "attack_real_tx_by_kind": dict(self.kinds),
                "min_sol": self.min_sol}


# ---------- IO helpers ----------

class Tail:
    """Complete lines appended to a file since the last call (a line still being written waits)."""

    def __init__(self, path):
        self.path, self.pos, self.lines = Path(path), 0, 0

    def read(self):
        if not self.path.exists():
            return []
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            data = f.read()
        end = data.rfind(b"\n")
        if end < 0:
            return []
        chunk = data[:end + 1]
        self.pos += len(chunk)
        out = []
        for line in chunk.split(b"\n")[:-1]:
            self.lines += 1
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def read_pending(self):
        """True when a complete line is waiting past the read position."""
        if not self.path.exists() or self.path.stat().st_size <= self.pos:
            return False
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            return b"\n" in f.read()


def append_lines(path, rows):
    """Appends JSON lines under an exclusive lock (several writers share events.jsonl)."""
    if not rows:
        return
    data = "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows).encode("utf-8")
    with open(path, "ab") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.write(data)
            f.flush()
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def write_atomic(path, obj):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# ---------- step 1: cases ----------

def cmd_cases(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cases_path = out / "cases.jsonl"
    done_ids = {c["case_id"] for c in ab.read_jsonl(cases_path)}
    exclude = {r["tx_digest"] for p in a.exclude if Path(p).exists() for r in sd.read_jsonl(p)}
    constructed, c_meta = constructed_cases(list(sd.read_jsonl(a.synthetic)), a.seed, a.min_sol)
    builder = MainnetBuilder(exclude, a.seed, a.min_sol, a.per_payer, a.n_attack, a.p_attack)
    tail = Tail(a.mainnet)
    emitted_constructed = 0
    written = 0
    last_meta = 0.0

    def emit(cases):
        nonlocal written
        new = [c for c in cases if c["case_id"] not in done_ids]
        done_ids.update(c["case_id"] for c in new)
        append_lines(cases_path, new)
        written += len(new)

    def write_meta(final):
        meta = {"updated_at": now_iso(), "final": final, "seed": a.seed, "injections": "TEST_ONLY_INJECTIONS",
                "excluded_digests": len(exclude), "exclude_files": list(a.exclude), "mainnet": builder.meta(),
                "constructed": {**c_meta, "cases_emitted": emitted_constructed, "cases_total": len(constructed)},
                "cases": len(done_ids)}
        write_atomic(out / "cases_meta.json", meta)
        return meta

    while True:
        for r in tail.read():
            cases = builder.add(r)
            if cases:
                emit(cases)
                want = min(len(constructed), len(builder.usable) // CONSTRUCTED_EVERY)
                if want > emitted_constructed:
                    emit(constructed[emitted_constructed:want])
                    emitted_constructed = want
        finished = not a.follow or (out / DONE_MARKER).exists()
        if finished and not tail.read_pending():
            emit(constructed[emitted_constructed:])
            emitted_constructed = len(constructed)
            meta = write_meta(True)
            (out / CASES_DONE).touch()
            print(json.dumps(meta, indent=1, ensure_ascii=False))
            return
        if time.time() - last_meta > 30:
            meta = write_meta(False)
            last_meta = time.time()
            print(f"{now_iso()} cases {meta['cases']} (new {written}) — real_traffic {builder.honest}, attack_real_tx "
                  f"{builder.attacks}, constructed {emitted_constructed}/{len(constructed)}", flush=True)
        time.sleep(a.poll)


# ---------- step 2: deterministic layers, streamed ----------

def decision_event(case, usd):
    t0 = time.perf_counter()
    a_ = ab.layer_a(case)
    t1 = time.perf_counter()
    b_ = ab.layer_b(case)
    t2 = time.perf_counter()
    final, by = ab.combine({"A": a_, "B": b_})
    signals = list(dict.fromkeys(a_["signals"] + b_["signals"]))
    return {"type": "decision", "case_id": case["case_id"], "set": case["set"], "source": case["source"],
            "kind": case["kind"], "expected": case["expected"], "decision": final, "layer": by,
            "signals": signals, "reasons": (a_["reasons"] + b_["reasons"])[:3],
            "layers": {"A": a_["decision"], "B": b_["decision"]},
            "latency_ms": {"A": round((t1 - t0) * 1000, 4), "B": round((t2 - t1) * 1000, 4)},
            "usd": None if usd[0] is None else round(usd[0], 2), "tx_digest": case["tx_digest"], "ts": now_iso()}


class Summary:
    """Live totals from the events (decision + model), per set."""

    def __init__(self, policy=None):
        self.policy = policy
        self.dec, self.model, self.base = {}, {}, {}
        self.events = 0
        self.started = time.time()

    def add(self, e):
        self.events += 1
        t = e.get("type")
        if t == "decision":
            self.dec[e["case_id"]] = e
        elif t == "model":
            self.model[e["case_id"]] = e
        elif t == "baseline":
            self.base[e["case_id"]] = e

    def final(self, cid):
        d = self.dec[cid]
        m = self.model.get(cid)
        if m is None:
            return d["decision"], d["layer"]
        # The model can only raise the risk of the A/B decision.
        c = ab.layer_c({"risk": m.get("risk"), "signals": m.get("signals", []), "format": m.get("format")})
        if ab.RANK[c["decision"]] > ab.RANK[d["decision"]]:
            return c["decision"], "C"
        return d["decision"], d["layer"]

    def model_expected(self, ids=None):
        """Cases the model is meant to score: already scored, plus the policy's sample."""
        ids = self.dec if ids is None else ids
        return sum(cid in self.model or model_wanted(cid, self.dec[cid]["set"], self.policy) for cid in ids)

    def build(self, n_cases, cases_meta=None, done=False):
        sets = {}
        for s in SETS:
            ids = [cid for cid, d in self.dec.items() if d["set"] == s]
            fin = Counter()
            exp = Counter()
            fp = fn = tp = tn = review_legit = review_attack = 0
            usd = defaultdict(float)
            usd_priced = Counter()
            by_layer = Counter()
            by_kind = defaultdict(Counter)
            lat = {"A": [], "B": [], "C": []}
            for cid in ids:
                d = self.dec[cid]
                f, layer = self.final(cid)
                fin[f] += 1
                exp[d["expected"]] += 1
                by_layer[layer or "—"] += 1
                by_kind[d["kind"]][f] += 1
                lat["A"].append(d["latency_ms"]["A"])
                lat["B"].append(d["latency_ms"]["B"])
                if cid in self.model and self.model[cid].get("latency_ms") is not None:
                    lat["C"].append(self.model[cid]["latency_ms"])
                attack = d["expected"] == BLOCK
                if attack:
                    tp += f == BLOCK
                    fn += f != BLOCK
                    review_attack += f == REVIEW
                else:
                    fp += f == BLOCK
                    tn += f != BLOCK
                    review_legit += f == REVIEW
                key = ("attack_" if attack else "legit_") + {BLOCK: "blocked", REVIEW: "review", ALLOW: "allowed"}[f]
                if d.get("usd") is not None:
                    usd[key] += d["usd"]
                    usd_priced[key] += 1
            n = len(ids)
            n_model = sum(cid in self.model for cid in ids)
            sets[s] = {"cases": n, "expected": {"BLOCK": exp[BLOCK], "ALLOW": exp[ALLOW]},
                       "final": {"BLOCK": fin[BLOCK], "ALLOW": fin[ALLOW], "REVIEW": fin[REVIEW]},
                       "tp": tp, "tn": tn, "fp": fp, "fn": fn, "review_legit": review_legit, "review_attack": review_attack,
                       "accuracy": round((tp + tn) / n, 6) if n else None,
                       "fp_rate": round(fp / (fp + tn), 6) if fp + tn else None,
                       "recall": round(tp / (tp + fn), 6) if tp + fn else None,
                       "value_usd": {k: round(v, 2) for k, v in usd.items()}, "value_priced_cases": dict(usd_priced),
                       "value_protected_usd": round(usd.get("attack_blocked", 0.0), 2),
                       "decided_by": dict(by_layer), "by_kind": {k: dict(v) for k, v in sorted(by_kind.items())},
                       "latency_ms": {k: {"n": len(v), "p50": ab.percentile(v, 50), "p95": ab.percentile(v, 95)}
                                      for k, v in lat.items()},
                       "model": {"done": n_model, "expected": self.model_expected(ids),
                                 "progress": round(n_model / self.model_expected(ids), 4) if self.model_expected(ids) else None}}
        decided = len(self.dec)
        n_model = len(self.model)
        elapsed = time.time() - self.started
        ab_ms = [d["latency_ms"]["A"] + d["latency_ms"]["B"] for d in self.dec.values()]
        c_ms = [m["latency_ms"] for m in self.model.values() if m.get("latency_ms") is not None]
        return {"updated_at": now_iso(), "done": done, "events": self.events, "cases_total": n_cases,
                "cases_decided": decided, "model_done": n_model,
                "model_progress": round(n_model / self.model_expected(), 4) if self.model_expected() else None,
                "model_expected": self.model_expected(),
                "model_policy": self.policy,
                "baseline_done": len(self.base),
                "throughput": {"deterministic_cases_per_s": round(1000 / ab.percentile(ab_ms, 50), 1) if ab_ms and ab.percentile(ab_ms, 50) else None,
                               "model_cases_per_s": round(1000 / ab.percentile(c_ms, 50), 3) if c_ms else None},
                "sets": sets, "cases_meta": cases_meta, "runner_elapsed_s": round(elapsed, 1)}


def load_prices(out):
    p = Path(out) / "prices.json"
    try:
        return json.loads(p.read_text()).get("prices", {})
    except (OSError, ValueError):
        return {}


def cmd_stream(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    events_path = out / "events.jsonl"
    summary = Summary(load_policy(out))
    ev_tail = Tail(events_path)
    for e in ev_tail.read():
        summary.add(e)
    decided = set(summary.dec)
    case_tail = Tail(out / "cases.jsonl")
    n_cases = 0
    since_summary = 0
    last_write = 0.0

    def cases_meta():
        try:
            return json.loads((out / "cases_meta.json").read_text())
        except (OSError, ValueError):
            return None

    def write_summary(done=False):
        write_atomic(out / "summary.json", summary.build(n_cases, cases_meta(), done))

    print(f"{now_iso()} stream: {len(decided)} cases already decided, {len(summary.model)} model events", flush=True)
    prices, prices_mtime = {}, object()
    while True:
        # prices.json may be refreshed while the run goes on (new mints): pick it up.
        try:
            m = (out / "prices.json").stat().st_mtime
        except OSError:
            m = None
        if m != prices_mtime:
            prices, prices_mtime = load_prices(out), m
        new_cases = case_tail.read()
        n_cases = case_tail.lines
        batch = []
        for c in new_cases:
            if c["case_id"] in decided:
                continue
            batch.append(decision_event(c, ab.usd_value(c["record"], prices)))
            decided.add(c["case_id"])
            if len(batch) >= 100:
                append_lines(events_path, batch)
                batch = []
        append_lines(events_path, batch)
        for e in ev_tail.read():
            summary.add(e)
            since_summary += 1
            if since_summary >= SUMMARY_EVERY:
                write_summary()
                since_summary = 0
                last_write = time.time()
        cases_done = (out / CASES_DONE).exists() and not case_tail.read_pending()
        summary.policy = load_policy(out)
        model_done = not a.wait_model or (len(decided) >= n_cases and len(summary.model) >= summary.model_expected())
        if cases_done and model_done and len(decided) >= n_cases:
            write_summary(done=True)
            print(f"{now_iso()} stream: done — {len(decided)} cases, {len(summary.model)} model events", flush=True)
            return
        if not a.follow and not new_cases:
            write_summary(done=cases_done and model_done)
            return
        # Quiet periods (model only) still refresh the summary now and then.
        if since_summary and time.time() - last_write > 60:
            write_summary()
            since_summary = 0
            last_write = time.time()
        time.sleep(a.poll)


# ---------- step 3: model worker (MLX) ----------

def _load_model(model_path, adapter):
    from mlx_lm import load
    from mlx_lm.sample_utils import make_sampler
    model, tok = load(model_path, adapter_path=adapter)
    return model, tok, make_sampler(temp=0.0)


def _ask(model, tok, sampler, case, max_tokens):
    from mlx_lm import generate
    from src.eval_risk import parse_answer
    prompt = tok.apply_chat_template(ab.model_prompt(case), add_generation_prompt=True, tokenize=False)
    t0 = time.perf_counter()
    text = generate(model, tok, prompt=prompt, max_tokens=max_tokens, sampler=sampler, verbose=False)
    return parse_answer(text), (time.perf_counter() - t0) * 1000, text


def model_event(case, pred, ms, text, etype="model", name="tuned"):
    a_, b_ = ab.layer_a(case), ab.layer_b(case)
    c_ = ab.layer_c(pred)
    final, by = ab.combine({"A": a_, "B": b_, "C": c_})
    return {"type": etype, "model": name, "case_id": case["case_id"], "set": case["set"], "expected": case["expected"],
            "risk": pred.get("risk"), "signals": pred.get("signals", []), "format": pred.get("format"),
            "decision_C": c_["decision"], "final": final, "layer": by, "latency_ms": round(ms, 1),
            "raw": (text or "")[:400], "ts": now_iso()}


def cmd_model(a):
    out = Path(a.out)
    events_path = out / "events.jsonl"
    done = {e["case_id"] for e in ab.read_jsonl(events_path) if e.get("type") == "model"}
    policy = load_policy(out)
    if a.sample:
        sample = {k: float(v) for k, v in (x.split("=") for x in a.sample.split(","))}
        policy = {"seed": SEED, "sample": sample, "since": now_iso(), "already_scored": len(done),
                  "reason": a.reason or "model throughput below case arrival rate"}
        write_atomic(out / MODEL_POLICY, policy)
    model, tok, sampler = _load_model(a.model, a.adapter)
    tail = Tail(out / "cases.jsonl")
    print(f"{now_iso()} model: {len(done)} already answered", flush=True)
    n = 0
    while True:
        cases = tail.read()
        for c in cases:
            if c["case_id"] in done or not model_wanted(c["case_id"], c["set"], policy):
                continue
            pred, ms, text = _ask(model, tok, sampler, c, a.max_tokens)
            append_lines(events_path, [model_event(c, pred, ms, text)])
            done.add(c["case_id"])
            n += 1
            if n % 50 == 0:
                print(f"{now_iso()} model: {len(done)}/{tail.lines} ({c['case_id']} risk={pred['risk']} {ms:.0f} ms)", flush=True)
        if not cases:
            if not a.follow or ((out / CASES_DONE).exists() and not tail.read_pending()):
                print(f"{now_iso()} model: done, {len(done)} answered", flush=True)
                return
            time.sleep(a.poll)


def stratified_sample(cases, n, seed=SEED, min_per_stratum=50):
    """~n cases, proportional per (set, expected) with a floor; chosen by seeded hash (stable)."""
    strata = defaultdict(list)
    for c in cases:
        strata[(c["set"], c["expected"])].append(c)
    total = len(cases)
    picked = []
    for key, cs in sorted(strata.items()):
        k = min(len(cs), max(min_per_stratum, round(n * len(cs) / total)))
        cs = sorted(cs, key=lambda c: _h(seed, "baseline", c["case_id"]))
        picked += cs[:k]
    return picked


def cmd_baseline(a):
    """Original (untuned) model on a stratified sample: type "baseline" events."""
    out = Path(a.out)
    events_path = out / "events.jsonl"
    cases = list(ab.read_jsonl(out / "cases.jsonl"))
    sample = stratified_sample(cases, a.n, min_per_stratum=a.min_per_stratum)
    done = {e["case_id"] for e in ab.read_jsonl(events_path) if e.get("type") == "baseline"}
    model, tok, sampler = _load_model(a.model, None)
    print(f"{now_iso()} baseline: {len(sample)} cases, {len(done)} done", flush=True)
    for i, c in enumerate(sample):
        if c["case_id"] in done:
            continue
        pred, ms, text = _ask(model, tok, sampler, c, a.max_tokens)
        append_lines(events_path, [model_event(c, pred, ms, text, "baseline", "original")])
        if i % 50 == 0:
            print(f"{now_iso()} baseline: {i + 1}/{len(sample)}", flush=True)
    print(f"{now_iso()} baseline: done", flush=True)


# ---------- prices ----------

def cmd_prices(a):
    """CoinGecko (public, keyless): SOL + mints that mainnet cases move out (2 calls)."""
    import urllib.parse
    import urllib.request
    out = Path(a.out)
    mints = sorted({m for c in ab.read_jsonl(out / "cases.jsonl") if c["source"] == "mainnet"
                    for m in ab.outflows(c["record"]) if m != sd.SOL})
    base = "https://api.coingecko.com/api/v3"
    headers = {"accept": "application/json", "user-agent": "aval-benchmark"}

    def get(url):
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
            return json.loads(r.read())

    listing = get(f"{base}/coins/list?include_platform=true")
    wanted = set(mints)
    ids, symbols = {}, {ab.WSOL: "SOL"}
    for coin in listing:
        addr = (coin.get("platforms") or {}).get("solana")
        if addr in wanted:
            ids.setdefault(addr, coin["id"])
            symbols.setdefault(addr, (coin.get("symbol") or "").upper())
    batch = sorted(set(ids.values()) | {"solana"})
    got = {}
    for i in range(0, len(batch), 250):
        got.update(get(f"{base}/simple/price?" + urllib.parse.urlencode({"ids": ",".join(batch[i:i + 250]), "vs_currencies": "usd"})))
        time.sleep(2)
    prices = {ab.WSOL: got["solana"]["usd"]}
    for mint, cid in ids.items():
        if got.get(cid, {}).get("usd") is not None:
            prices[mint] = got[cid]["usd"]
    res = {"fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"), "source": "CoinGecko public API",
           "mints_requested": len(mints) + 1, "prices": prices, "symbols": symbols,
           "errors": [f"{len(wanted - set(ids))} mints sem id na CoinGecko"] if wanted - set(ids) else []}
    write_atomic(out / "prices.json", res)
    print(json.dumps({k: res[k] for k in ("fetched_at", "mints_requested", "errors")}), f"priced: {len(prices)}")


# ---------- final report (HTML, PT-BR) ----------

SET_PT = {"real_traffic": "Tráfego real", "attack_real_tx": "Transação real, intenção forjada",
          "attack_constructed": "Construídos (VM local)"}


def collection_stats(log_path):
    """Calls (summed over resumed runs), blocks, scanned and kept from the collector log."""
    import re
    runs, cur, last = [], {}, None
    pat = re.compile(r"kept (\d+)/\d+ — scanned (\d+) \(failed (\d+), no signer effect (\d+), errored (\d+)\) — "
                     r"blocks (\d+) \(block errors (\d+), duplicates skipped (\d+)\) — calls (\d+)")
    try:
        lines = open(log_path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return {}
    for line in lines:
        if line.startswith("dataset: upstream"):
            if cur:
                runs.append(cur)
            cur = {}
        m = pat.search(line)
        if m:
            k = ("kept", "scanned", "failed", "no_effect", "errored", "blocks", "block_errors", "duplicates", "calls")
            cur = dict(zip(k, map(int, m.groups())))
            last = cur["kept"]
    if cur:
        runs.append(cur)
    tot = {k: sum(r.get(k, 0) for r in runs) for k in ("scanned", "failed", "no_effect", "errored", "blocks", "block_errors", "calls")}
    tot["kept"] = last
    tot["runs"] = len(runs)
    tot["http_429"] = sum("HTTP 429" in line for line in lines)
    tot["decode_errors"] = sum("error decoding response body" in line for line in lines)
    return tot


def report_rows(out, prices):
    """One row per case: final decision (A/B/C), model answers, USD at the final prices."""
    dec, model, base = {}, {}, {}
    for e in ab.read_jsonl(out / "events.jsonl"):
        {"decision": dec, "model": model, "baseline": base}.get(e.get("type"), {})[e.get("case_id")] = e
    rows = []
    for c in ab.read_jsonl(out / "cases.jsonl"):
        d = dec.get(c["case_id"])
        if d is None:
            continue
        m = model.get(c["case_id"])
        b = base.get(c["case_id"])
        pred = {"risk": m["risk"], "signals": m["signals"], "format": m["format"]} if m else None
        c_ = ab.layer_c(pred)
        final, by = (c_["decision"], "C") if ab.RANK[c_["decision"]] > ab.RANK[d["decision"]] else (d["decision"], d["layer"])
        usd, missing = ab.usd_value(c["record"], prices)
        rows.append({"case_id": c["case_id"], "set": c["set"], "kind": c["kind"], "expected": c["expected"],
                     "source": c["source"], "tx_digest": c["tx_digest"], "ab": d["decision"], "ab_by": d["layer"],
                     "A": d["layers"]["A"], "B": d["layers"]["B"], "final": final, "by": by,
                     "tuned": pred, "original": {"risk": b["risk"], "signals": b["signals"]} if b else None,
                     "lat": {"A": d["latency_ms"]["A"], "B": d["latency_ms"]["B"], "C": m["latency_ms"] if m else None},
                     "usd": usd, "usd_missing": missing, "metadata": c.get("metadata", {}),
                     "intent_action": c["intent"]["action"]})
    return rows


def _lat(vals):
    return {"n": len(vals), "p50": ab.percentile(vals, 50), "p95": ab.percentile(vals, 95),
            "mean": sum(vals) / len(vals) if vals else None}


def headline(rows, synth_us=()):
    """The four separate headline numbers: (a) real traffic, (b) attacks on real txs, (c) constructed + twins, (d) latency."""
    by_set = defaultdict(list)
    for r in rows:
        by_set[r["set"]].append(r)
    rt, ar, ac = by_set["real_traffic"], by_set["attack_real_tx"], by_set["attack_constructed"]
    scored = [r for r in rt if r["tuned"] is not None]
    fc = lambda rs, key="final": Counter(r[key] for r in rs)  # noqa: E731
    share = lambda k, n: round(k / n, 4) if n else None  # noqa: E731
    att_c = [r for r in ac if r["expected"] == BLOCK]
    twins = [r for r in ac if r["expected"] == ALLOW]
    swaps = [r for r in scored if r["kind"] == "legit:swap"]
    return {
        "real_traffic": {
            "n": len(rt), "false_blocks": fc(rt)[BLOCK],
            "code_only": {"n": len(rt), "allow": fc(rt, "ab")[ALLOW], "block": fc(rt, "ab")[BLOCK],
                          "allow_share": share(fc(rt, "ab")[ALLOW], len(rt))},
            "with_model": {"n": len(scored), "allow": fc(scored)[ALLOW], "review": fc(scored)[REVIEW], "block": fc(scored)[BLOCK],
                           "allow_share": share(fc(scored)[ALLOW], len(scored)), "review_share": share(fc(scored)[REVIEW], len(scored))},
            "final_all": {"allow": fc(rt)[ALLOW], "review": fc(rt)[REVIEW], "block": fc(rt)[BLOCK],
                          "allow_share": share(fc(rt)[ALLOW], len(rt)), "review_share": share(fc(rt)[REVIEW], len(rt))},
            "swap_review": {"n": len(swaps), "review": fc(swaps)[REVIEW], "share": share(fc(swaps)[REVIEW], len(swaps))}},
        "attack_real_tx": {"n": len(ar), "blocked": fc(ar)[BLOCK], "review": fc(ar)[REVIEW], "allowed": fc(ar)[ALLOW]},
        "attack_constructed": {"attacks": len(att_c), "blocked": fc(att_c)[BLOCK], "review": fc(att_c)[REVIEW],
                               "allowed": fc(att_c)[ALLOW], "twins": len(twins), "twins_allow": fc(twins)[ALLOW],
                               "twins_review": fc(twins)[REVIEW], "twins_block": fc(twins)[BLOCK]},
        "latency_ms": {"A+B": _lat([r["lat"]["A"] + r["lat"]["B"] for r in rows]),
                       "model": _lat([r["lat"]["C"] for r in rows if r["lat"]["C"] is not None]),
                       "sim_constructed": _lat([v / 1000 for v in synth_us])},
    }


def render_report(rows, meta, prices_meta, coll, synth_us, snapshot=None, policy=None):
    E, card, table, usd, pct, ms = ab._e, ab.card, ab.table, ab._usd, ab._pct, ab._ms
    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    by_set = defaultdict(list)
    for r in rows:
        by_set[r["set"]].append(r)
    rt, ar, ac = by_set["real_traffic"], by_set["attack_real_tx"], by_set["attack_constructed"]
    parts = []
    P = parts.append
    mm = (meta or {}).get("mainnet", {})
    title = "Relatório AVAL — Benchmark Solana (demo, snapshot)" if snapshot else "Relatório AVAL — Benchmark Solana 20k"
    cut = f" · retrato congelado em {E(snapshot['cutoff'])} (execução em andamento)" if snapshot else ""
    P(f"<h1>{title}</h1><div class='sub'>Gerado em {now}{cut} · {len(rt)} transações reais da "
      f"mainnet + suíte de ataques ({len(ar)} transações reais com intenção forjada, {sum(r['expected'] == BLOCK for r in ac)} "
      f"ataques construídos e {sum(r['expected'] == ALLOW for r in ac)} gêmeos honestos) · seed {meta.get('seed')} · modelo: "
      f"base bf16 de Luis + LoRA veto-svm iter 300 (guloso)</div>")

    # ---- Headline: four separate numbers ----
    h = headline(rows, synth_us)
    hr, ha, hc, hl = h["real_traffic"], h["attack_real_tx"], h["attack_constructed"], h["latency_ms"]
    P("<h2>Resumo: quatro números separados</h2>")
    P("<div class='cards'>")
    P(card(f"{hr['false_blocks']} bloqueios indevidos", f"(a) tráfego real: {hr['n']} transações da mainnet",
           "red" if hr["false_blocks"] else "green"))
    P(card(f"{ha['blocked']}/{ha['n']}", "(b) ataques em transações reais bloqueados", "green" if ha["blocked"] == ha["n"] else "red"))
    P(card(f"{hc['blocked']}/{hc['attacks']}", f"(c) ataques construídos bloqueados · gêmeos honestos aprovados "
           f"{hc['twins_allow']}/{hc['twins']}", "green" if hc["blocked"] == hc["attacks"] else "red"))
    P("</div>")
    cw = hr["with_model"]
    P(table(["(a) Tráfego real", "Transações", "ALLOW automático", "REVIEW", "BLOCK (falso)"],
            [["Só código (camadas A + B), todas", hr["code_only"]["n"], f"{hr['code_only']['allow']} ({pct(hr['code_only']['allow_share'], 1)})",
              "—", hr["code_only"]["block"]],
             ["Com a IA (casos que a IA já avaliou)", cw["n"], f"{cw['allow']} ({pct(cw['allow_share'], 1)})",
              f"{cw['review']} ({pct(cw['review_share'], 1)})", cw["block"]],
             ["Decisão final, todas (sem IA ainda = só código)", hr["n"], f"{hr['final_all']['allow']} ({pct(hr['final_all']['allow_share'], 1)})",
              f"{hr['final_all']['review']} ({pct(hr['final_all']['review_share'], 1)})", hr["final_all"]["block"]]]))
    P(f"<p class='note'>A IA avaliou {cw['n']} de {hr['n']} transações reais ({pct(cw['n'] / hr['n'] if hr['n'] else None, 1)}) "
      f"e {sum(r['tuned'] is not None for r in rows)} de {len(rows)} casos no total; os demais mostram o resultado só do código.</p>")
    if policy:
        P(f"<p class='note'>Decisão registrada: a IA (~0,6 caso/s) ficou atrás da chegada de casos, então a partir de "
          f"{E(policy.get('since', '—'))} ela avaliou só uma amostra semeada (seed {policy.get('seed')}) por conjunto: "
          f"{E(', '.join(f'{SET_PT.get(k, k)} {v:.0%}' for k, v in policy.get('sample', {}).items()))} (os demais 100%). "
          f"Os {policy.get('already_scored', 0)} casos avaliados antes continuam. Todo caso tem o resultado só do código; "
          "as linhas “com a IA” valem só para os casos avaliados por ela.</p>")
    P(table(["(d) Latência", "Casos", "p50", "p95"],
            [["Camadas A + B (código)", hl["A+B"]["n"], ms(hl["A+B"]["p50"]), ms(hl["A+B"]["p95"])],
             ["IA de intenção (MLX, Apple M4 Pro)", hl["model"]["n"], ms(hl["model"]["p50"]), ms(hl["model"]["p95"])],
             ["Simulação aval-svm (construídos, estado em memória)", hl["sim_constructed"]["n"], ms(hl["sim_constructed"]["p50"]),
              ms(hl["sim_constructed"]["p95"])]]))

    # ---- Headline 1: real traffic ----
    n = len(rt)
    blocked = [r for r in rt if r["final"] == BLOCK]
    review = [r for r in rt if r["final"] == REVIEW]
    lat_ab = [r["lat"]["A"] + r["lat"]["B"] for r in rt]
    lat_c = [r["lat"]["C"] for r in rt if r["lat"]["C"] is not None]
    lab, lc = _lat(lat_ab), _lat(lat_c)
    P(f"<h2>1. Tráfego real (mainnet, {n} transações)</h2>")
    P("<p class='note'>Cada transação real da mainnet, simulada pelo aval-svm, com a intenção honesta derivada dos seus "
      "efeitos. Todas deveriam ser aprovadas: aqui se mede o atrito que o Aval impõe ao uso normal.</p>")
    answered = sum(r["tuned"] is not None for r in rt)
    if answered < n:
        P(f"<p class='note red'>Parcial: a IA respondeu {answered} de {n} transações; as demais contam só o código.</p>")
    P("<div class='cards'>")
    P(card(f"{len(blocked)}", f"falsos positivos (BLOCK) · taxa {pct(len(blocked) / n if n else None, 2)}", "red" if blocked else "green"))
    P(card(f"{len(review)}", f"REVIEW (IA levantou risco) · {pct(len(review) / n if n else None, 1)}"))
    P(card(f"{n - len(blocked) - len(review)}", f"aprovadas direto · {pct((n - len(blocked) - len(review)) / n if n else None, 1)}", "green"))
    P(card(ms(lab["p50"]), f"latência A+B p50 (p95 {ms(lab['p95'])})"))
    P(card(ms(lc["p50"]), f"latência da IA p50 (p95 {ms(lc['p95'])})"))
    thr_ab = 1000 / lab["p50"] if lab["p50"] else None
    thr_c = 1000 / lc["p50"] if lc["p50"] else None
    P(card(f"{thr_ab:,.0f}/s".replace(",", ".") if thr_ab else "—", f"vazão A+B por núcleo · IA {thr_c:.2f}/s".replace(".", ",") if thr_c else "vazão A+B"))
    P("</div>")
    body = []
    kinds = Counter(r["kind"] for r in rt)
    for k, cnt in kinds.most_common():
        rs = [r for r in rt if r["kind"] == k]
        f = Counter(r["final"] for r in rs)
        body.append([E(ab._type_name(k)), cnt, f[ALLOW], f[REVIEW], f'<span class="{"red" if f[BLOCK] else ""}">{f[BLOCK]}</span>',
                     pct(f[REVIEW] / cnt, 1)])
    P("<h3>Por tipo de transação</h3>")
    P(table(["Tipo (intenção derivada)", "Transações", "ALLOW", "REVIEW", "BLOCK (FP)", "Taxa de REVIEW"], body))
    sig = Counter(s for r in review for s in (r["tuned"] or {}).get("signals", []) or ["(sem sinal)"])
    P("<h3>Por que a IA pediu REVIEW</h3>")
    P(table(["Sinal nomeado pela IA", "Casos"], [[E(ab.ATTACK_PT.get(k, k)), v] for k, v in sig.most_common()]) if sig else "<p>Nenhum.</p>")
    v_ok = sum(r["usd"] or 0 for r in rt if r["final"] == ALLOW)
    v_rev = sum(r["usd"] or 0 for r in review)
    v_blk = sum(r["usd"] or 0 for r in blocked)
    priced = sum(r["usd"] is not None and not r["usd_missing"] for r in rt)
    P(f"<p class='note'>Valor movimentado (cotação CoinGecko de {E(prices_meta.get('fetched_at', '—'))}): aprovadas "
      f"{usd(v_ok)}, em REVIEW {usd(v_rev)}, bloqueadas {usd(v_blk)}. {priced} de {n} transações com todas as cotações; "
      f"tokens sem cotação contam US$ 0.</p>")
    mc = coll or {}
    P(f"<p class='note'>Coleta: blocos finalizados recentes via Helius (plano grátis, 9 req/s), {mc.get('blocks', '—')} blocos, "
      f"{mc.get('scanned', '—')} transações simuladas ({mc.get('failed', '—')} falharam na simulação contra o estado atual, "
      f"{mc.get('no_effect', '—')} sem efeito no signatário), {mc.get('kept', '—')} registros, {mc.get('calls', '—')} chamadas RPC "
      f"({mc.get('http_429', 0)} respostas 429 e {mc.get('decode_errors', 0)} respostas truncadas, refeitas). Filtros: {mm.get('records', '—')} registros → {mm.get('usable', '—')} "
      f"utilizáveis; descartes {E(json.dumps(mm.get('skipped', {}), ensure_ascii=False))}; teto de {mm.get('payer_cap')} por "
      f"pagador ({mm.get('payer_cap_dropped', 0)} descartadas por ele, {mm.get('payers', '—')} pagadores distintos). "
      f"{mm.get('attack_real_tx', 0)} registros sorteados antes foram para a suíte de ataques (conjuntos disjuntos).</p>")

    # ---- Headline 2: attack suite ----
    P("<h2>2. Suíte de ataques</h2>")
    P("<p class='note'>Ataques nunca se misturam com o tráfego real. Duas fontes, mostradas lado a lado: transações "
      "construídas na VM local e transações reais da mainnet com uma intenção forjada.</p>")
    body = []
    for name, rs in (("attack_constructed", [r for r in ac if r["expected"] == BLOCK]), ("attack_real_tx", ar)):
        f = Counter(r["final"] for r in rs)
        val = sum(r["usd"] or 0 for r in rs if r["final"] == BLOCK)
        body.append([f"<b>{E(SET_PT[name])}</b>", len(rs), f'<span class="green">{f[BLOCK]}</span>', f[REVIEW],
                     f'<span class="{"red" if f[ALLOW] else "green"}">{f[ALLOW]}</span>',
                     pct(f[BLOCK] / len(rs) if rs else None, 2), usd(val) if name == "attack_real_tx" else "sem cotação"])
    P(table(["Conjunto", "Ataques", "Bloqueados", "REVIEW", "Não bloqueados (ALLOW)", "Taxa de bloqueio", "Valor protegido"], body))
    twins = [r for r in ac if r["expected"] == ALLOW]
    tf = Counter(r["final"] for r in twins)
    P(f"<p class='note'>Gêmeos honestos dos construídos: {len(twins)} casos, {tf[BLOCK]} BLOCK (falso positivo), "
      f"{tf[REVIEW]} REVIEW, {tf[ALLOW]} ALLOW.</p>")
    P("<h3>Por tipo de ataque</h3>")
    body = []
    for k in sd.MUTATIONS:
        row = [E(ab.ATTACK_PT.get(k, k))]
        for rs in ([r for r in ac if r["kind"] == k], [r for r in ar if r["kind"] == k]):
            f = Counter(r["final"] for r in rs)
            whys = Counter(r["by"] or "—" for r in rs if r["final"] == BLOCK)
            row += [len(rs), f"{f[BLOCK]} <small>({', '.join(f'{a}:{b}' for a, b in sorted(whys.items()))})</small>" if rs else "—",
                    f[ALLOW] + f[REVIEW] if rs else "—"]
        body.append(row)
    P(table(["Tipo", "Construídos", "Bloqueados (camada)", "Escaparam", "Reais forjados", "Bloqueados (camada)", "Escaparam"], body))
    missed = [r for r in ac + ar if r["expected"] == BLOCK and r["final"] != BLOCK]
    P("<h3>Ataques não bloqueados</h3>")
    P(table(["Caso", "Conjunto", "Tipo", "Final", "IA"], [[r["case_id"], E(SET_PT[r["set"]]), E(ab._type_name(r["kind"])), r["final"],
                                                       E((r["tuned"] or {}).get("risk", "sem resposta"))] for r in missed[:200]])
      if missed else "<p>Nenhum.</p>")

    # ---- Model (non-circular) ----
    P("<h2>IA de intenção (medida não circular)</h2>")
    body = []
    for name, rs in (("real_traffic", rt), ("attack_real_tx", ar), ("attack_constructed", ac)):
        for exp in (ALLOW, BLOCK):
            g = [r for r in rs if r["expected"] == exp]
            if not g:
                continue
            t = [r for r in g if r["tuned"]]
            o = [r for r in g if r["original"]]
            ok = lambda r, k: (r[k]["risk"] == "high") == (exp == BLOCK)  # noqa: E731
            named = sum(r["kind"] in r["tuned"]["signals"] for r in t) if exp == BLOCK else None
            body.append([E(SET_PT[name]), exp, len(g), f"{sum(ok(r, 'tuned') for r in t)}/{len(t)} ({pct(sum(ok(r, 'tuned') for r in t) / len(t) if t else None)})",
                         "—" if named is None else f"{named} ({pct(named / len(t) if t else None)})",
                         f"{sum(ok(r, 'original') for r in o)}/{len(o)} ({pct(sum(ok(r, 'original') for r in o) / len(o) if o else None)})"])
    P(table(["Conjunto", "Esperado", "Casos", "IA ajustada: acertos", "IA ajustada: nomeou o sinal", "IA original (amostra): acertos"], body))
    n_base = sum(r["original"] is not None for r in rows)
    P("<p class='note'>Acerto da IA sozinha: <i>high</i> em ataques, <i>low</i> em legítimas. "
      + (f"A IA original foi rodada só numa amostra estratificada de {n_base} casos (proporcional por conjunto × esperado, "
         "com piso por estrato).</p>" if n_base else "IA original: pendente (ainda não rodada).</p>"))

    # ---- Latency ----
    P("<h2>Latência</h2>")
    L = [("Camada A — comparação intenção x efeitos simulados (código)", _lat([r["lat"]["A"] for r in rows])),
         ("Camada B — detector de injeção (código)", _lat([r["lat"]["B"] for r in rows])),
         ("Camada C — IA de intenção (MLX, Apple M4 Pro)", _lat([r["lat"]["C"] for r in rows if r["lat"]["C"] is not None])),
         ("Simulação aval-svm (construídos, estado em memória)", _lat([v / 1000 for v in synth_us]))]
    P(table(["Etapa", "Casos medidos", "p50", "p95", "Média"], [[E(k), v["n"], ms(v["p50"]), ms(v["p95"]), ms(v["mean"])] for k, v in L]))
    P("<p class='note'>A simulação das transações da mainnet não é cronometrada aqui: na coleta ela inclui a busca de "
      "estado no RPC sob o limite de 9 req/s do plano grátis, o que mede a fila e não o Aval.</p>")

    # ---- How to read ----
    # ---- Limitations ----
    P("<h2>Limitações</h2><ul class='read'>")
    if snapshot:
        P(f"<li><b>Não são 20 mil transações.</b> Este é um retrato congelado de uma execução em andamento: "
          f"{hr['n']} transações reais e {ha['n']} ataques em transações reais até {E(snapshot['cutoff'])}. "
          f"O relatório final (meta ≥ 20 mil transações reais) sai quando a coleta e a IA terminarem.</li>")
    P("<li><b>Como os ataques foram feitos.</b> Nenhum ataque é um golpe real observado na mainnet. Os “reais forjados” são "
      "transações reais legítimas cuja intenção declarada foi alterada por código (destinatário, valor, ativo, approve ou "
      "autoridade escondidos, injeção nos metadados). Os “construídos” são transações de permissão de token montadas na VM "
      "local (seed 9001) com os programas SPL reais. As injeções usam só os modelos reservados para teste.</li>")
    P("<li><b>A checagem de rótulo é circular.</b> O gabarito dos ataques sai da mesma função de comparação "
      "(<code>label()</code>) que a Camada A executa, e o detector da Camada B usa o mesmo padrão que gerou as injeções. "
      "Os 100% de bloqueio mostram o mecanismo funcionando em transações reais simuladas, não habilidade independente de "
      "detecção. Pelo mesmo motivo, 0 falso positivo do código no tráfego real é esperado: a intenção honesta é derivada dos "
      "próprios efeitos.</li>")
    sw = hr["swap_review"]
    P(f"<li><b>A IA pede REVIEW demais em swaps.</b> Nos swaps reais que ela avaliou, {sw['review']} de {sw['n']} "
      f"({pct(sw['share'], 1)}) foram para REVIEW — quase sempre alegando valor menor que o real ou troca de destinatário, "
      "o que não acontece (o código confirma). É atrito de UX, não bloqueio: pela regra da equipe a IA só levanta risco, "
      "e sem <code>injected_instruction</code> isso vira REVIEW, nunca BLOCK.</li>")
    P("<li><b>Simulação contra estado atual.</b> Cada transação foi re-simulada contra o estado de agora; as que falham nessa "
      "repetição (a maioria, por estado já consumido) ficam fora da amostra, o que favorece tipos de transação estáveis.</li>")
    P("</ul>")
    P("<h2>Como ler estes números</h2><ul class='read'>")
    P("<li><b>Dois números, nunca somados.</b> O tráfego real mede atrito (falsos positivos e REVIEW em uso normal); a "
      "suíte de ataques mede proteção. Uma “acurácia geral” misturando os dois dependeria só da proporção escolhida.</li>")
    P("<li><b>A Camada A é circular por construção.</b> Os rótulos dos ataques de intenção x efeito vêm da mesma lógica de "
      "comparação (<code>label()</code>) que a Camada A executa; o mesmo vale para a Camada B e o padrão de injeção. Os "
      "bloqueios delas mostram o mecanismo funcionando de ponta a ponta em transações reais simuladas, não habilidade "
      "independente.</li>")
    P("<li><b>A IA é a medida não circular.</b> A tabela da IA mostra o que o modelo acerta sozinho, sem ver o rótulo.</li>")
    P("<li><b>Zero falso positivo no tráfego real é esperado pela construção</b>: a intenção honesta é derivada dos próprios "
      "efeitos simulados. O que esse conjunto testa de fato é se metadados comuns e a IA geram atrito (REVIEW).</li>")
    P("<li><b>REVIEW</b> não é BLOCK: é a IA levantando risco sem confirmação do código (regra “o LLM opina, o código "
      "decide”: <i>high</i> + <code>injected_instruction</code> → BLOCK; outro <i>high</i> → REVIEW).</li>")
    P("<li><b>Dados novos.</b> Nenhuma transação de arquivos anteriores (treino e benchmark de 1000) entra aqui; os ataques "
      "construídos usam seed 9001 (treino 42, benchmark anterior 777); as injeções vêm só de <code>TEST_ONLY_INJECTIONS</code>.</li>")
    P("<li><b>Nada foi assinado nem enviado.</b> Tudo é simulação; custo zero (plano grátis do RPC).</li>")
    P("</ul>")
    return ab.PAGE.replace("{{BODY}}", "\n".join(parts)).replace("<title>Relatório AVAL Solana</title>",
                                                                 "<title>Relatório AVAL Solana 20k</title>")


def cmd_report(a):
    out = Path(a.out)
    snapshot = {"cutoff": a.snapshot} if a.snapshot else None
    prices_meta = json.loads((out / "prices.json").read_text()) if (out / "prices.json").exists() else {"prices": {}}
    meta = json.loads((out / "cases_meta.json").read_text())
    rows = report_rows(out, prices_meta.get("prices", {}))
    coll = collection_stats(out / "collect.log")
    synth_us = [r["sim_us"] for r in ab.read_jsonl(out / "synth_sim_timings.jsonl")]
    html_path = Path(a.html) if a.html else out / "relatorio_aval_20k.html"
    html_path.write_text(render_report(rows, meta, prices_meta, coll, synth_us, snapshot, load_policy(out)), encoding="utf-8")
    write_atomic(html_path.with_suffix(".headline.json"), headline(rows, synth_us))
    write_atomic(out / "report_stats.json", {"collection": coll, "cases": len(rows),
                                             "by_set_final": {s: dict(Counter(f"{r['expected']}->{r['final']}" for r in rows if r["set"] == s)) for s in SETS}})
    print(json.dumps({"collection": coll, "rows": len(rows)}, ensure_ascii=False))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default=str(OUT))
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cases")
    c.add_argument("--mainnet", default=str(MAINNET))
    c.add_argument("--synthetic", default=str(SYNTH))
    c.add_argument("--exclude", nargs="*", default=list(EXCLUDE))
    c.add_argument("--seed", type=int, default=SEED)
    c.add_argument("--min-sol", type=float, default=0.001)
    c.add_argument("--per-payer", type=int, default=PER_PAYER)
    c.add_argument("--n-attack", type=int, default=N_ATTACK_REAL)
    c.add_argument("--p-attack", type=float, default=P_ATTACK_REAL)
    c.add_argument("--follow", action="store_true", help="keep reading until results/bench20k/collection_done exists")
    c.add_argument("--poll", type=float, default=5.0)
    s = sub.add_parser("stream")
    s.add_argument("--follow", action="store_true")
    s.add_argument("--wait-model", action="store_true", help="only finish once the model answered every case")
    s.add_argument("--poll", type=float, default=2.0)
    for name in ("model", "baseline"):
        m = sub.add_parser(name)
        m.add_argument("--model", default="models/veto-merged-bf16")
        m.add_argument("--max-tokens", type=int, default=200)
        m.add_argument("--poll", type=float, default=5.0)
        if name == "model":
            m.add_argument("--adapter", default="models/veto-svm-lora")  # adapters.safetensors = iter 300
            m.add_argument("--follow", action="store_true")
            m.add_argument("--sample", help="seeded per-set sample from now on, e.g. real_traffic=0.5,attack_constructed=0.5")
            m.add_argument("--reason")
        else:
            m.add_argument("--n", type=int, default=2000)
            m.add_argument("--min-per-stratum", type=int, default=50)
    sub.add_parser("prices")
    rp = sub.add_parser("report")
    rp.add_argument("--html", help="output HTML (default <out>/relatorio_aval_20k.html)")
    rp.add_argument("--snapshot", help="cutoff label: renders the demo/snapshot variant")
    a = p.parse_args(argv)
    {"cases": cmd_cases, "stream": cmd_stream, "model": cmd_model, "baseline": cmd_baseline, "prices": cmd_prices,
     "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
