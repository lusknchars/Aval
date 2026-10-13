"""Avalia um modelo MLX (base ou base+adapter LoRA) num jsonl do dataset aval-svm (formato risk).

Usa as MESMAS mensagens system+user do dataset, decodificação gulosa (temp 0), e aceita duas formas de resposta:
risk ``{"risk":"low|high",...}`` ou a decisão legada ``{"decision":"ALLOW|BLOCK|REVIEW",...}`` (BLOCK/REVIEW = high).
Qualquer outra coisa é inválida (conta como erro na acurácia).

    .venv-mlx/bin/python -m src.eval_risk --model models/veto-merged-bf16 \\
        --data results/svm_dataset/test_mainnet.jsonl --name baseline_mainnet
    .venv-mlx/bin/python -m src.eval_risk --model models/veto-merged-bf16 --adapter models/veto-svm-lora \\
        --data results/svm_dataset/test_mainnet.jsonl --name tuned_mainnet
"""
import argparse
import json
import math
import re
import time
from collections import defaultdict
from pathlib import Path

HIGH_DECISIONS = {"BLOCK": "high", "REVIEW": "high", "ALLOW": "low"}


# ---------- parsing (pure) ----------

def _json_obj(text):
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw).strip()
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return None
        try:
            obj = json.loads(m.group())
        except ValueError:
            return None
    return obj if isinstance(obj, dict) else None


def parse_answer(text):
    """Model text → {"risk": "low"|"high"|None, "signals": [...], "format": "risk"|"decision"|"invalid"}."""
    obj = _json_obj(text)
    if obj is not None:
        risk = str(obj.get("risk", "")).strip().lower()
        if risk in ("low", "high"):
            sig = obj.get("signals")
            signals = [str(s) for s in sig] if isinstance(sig, list) else []
            return {"risk": risk, "signals": signals, "format": "risk"}
        decision = str(obj.get("decision", "")).strip().upper()
        if decision in HIGH_DECISIONS:
            return {"risk": HIGH_DECISIONS[decision], "signals": [], "format": "decision"}
    return {"risk": None, "signals": [], "format": "invalid"}


def expected_of(example):
    """Gold label from the dataset's assistant message."""
    obj = json.loads(example["messages"][-1]["content"])
    return {"risk": obj["risk"], "signals": list(obj.get("signals", []))}


# ---------- metrics (pure) ----------

def wilson(k, n, z=1.96):
    """Wilson 95% interval for k successes out of n → (low, high); (None, None) if n == 0."""
    if n == 0:
        return None, None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)


def _ratio(k, n):
    return round(k / n, 4) if n else None


def _summary(rows):
    n = len(rows)
    correct = sum(r["pred"]["risk"] == r["gold"]["risk"] for r in rows)
    invalid = sum(r["pred"]["format"] == "invalid" for r in rows)
    tp = sum(r["gold"]["risk"] == "high" and r["pred"]["risk"] == "high" for r in rows)
    fp = sum(r["gold"]["risk"] == "low" and r["pred"]["risk"] == "high" for r in rows)
    fn = sum(r["gold"]["risk"] == "high" and r["pred"]["risk"] != "high" for r in rows)
    prec, rec = _ratio(tp, tp + fp), _ratio(tp, tp + fn)
    f1 = _ratio(2 * tp, 2 * tp + fp + fn)
    lo, hi = wilson(correct, n)
    return {"n": n, "accuracy": _ratio(correct, n), "accuracy_ci95": [lo, hi], "invalid": invalid,
            "invalid_rate": _ratio(invalid, n), "high_precision": prec, "high_recall": rec, "high_f1": f1,
            "tp": tp, "fp": fp, "fn": fn,
            "formats": {f: sum(r["pred"]["format"] == f for r in rows) for f in ("risk", "decision", "invalid")}}


def per_signal(rows):
    """For each gold signal: detection recall (predicted high) and naming recall (signal listed), Wilson CI.
    Gold-low examples appear under "none" with the share correctly answered low (specificity)."""
    groups = defaultdict(list)
    for r in rows:
        for s in r["gold"]["signals"] or ["none"]:
            groups[s].append(r)
    out = {}
    for s, rs in sorted(groups.items()):
        n = len(rs)
        if s == "none":
            k = sum(r["pred"]["risk"] == "low" for r in rs)
            out[s] = {"n": n, "specificity": _ratio(k, n), "ci95": list(wilson(k, n))}
            continue
        k = sum(r["pred"]["risk"] == "high" for r in rs)
        named = sum(s in r["pred"]["signals"] for r in rs)
        out[s] = {"n": n, "recall": _ratio(k, n), "ci95": list(wilson(k, n)),
                  "named": _ratio(named, n), "named_ci95": list(wilson(named, n))}
    return out


def metrics(rows):
    """rows: [{"source", "gold": {risk, signals}, "pred": parse_answer(...)}] → report dict."""
    by_source = defaultdict(list)
    for r in rows:
        by_source[r.get("source", "unknown")].append(r)
    return {"overall": _summary(rows), "per_signal": per_signal(rows),
            "per_source": {s: _summary(rs) for s, rs in sorted(by_source.items())}}


# ---------- model run ----------

def run(model_path, data, adapter=None, max_tokens=200, source=None, limit=None):
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tok = load(model_path, adapter_path=adapter)
    sampler = make_sampler(temp=0.0)
    default_source = source or Path(data).stem.removeprefix("test_")
    rows = []
    lines = [l for l in Path(data).read_text(encoding="utf-8").splitlines() if l.strip()]
    for i, line in enumerate(lines[:limit] if limit else lines):
        ex = json.loads(line)
        prompt = tok.apply_chat_template(ex["messages"][:2], add_generation_prompt=True, tokenize=False)
        text = generate(model, tok, prompt=prompt, max_tokens=max_tokens, sampler=sampler, verbose=False)
        rows.append({"i": i, "source": ex.get("source", default_source), "gold": expected_of(ex),
                     "pred": parse_answer(text), "raw": text})
        print(f"[{i + 1}/{len(lines)}] gold={rows[-1]['gold']['risk']} pred={rows[-1]['pred']['risk']} "
              f"fmt={rows[-1]['pred']['format']}", flush=True)
    return rows


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", required=True)
    p.add_argument("--adapter")
    p.add_argument("--data", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--out-dir", default="results/eval")
    p.add_argument("--max-tokens", type=int, default=200)
    p.add_argument("--limit", type=int)
    a = p.parse_args(argv)
    t0 = time.time()
    rows = run(a.model, a.data, a.adapter, a.max_tokens, limit=a.limit)
    report = {"name": a.name, "model": a.model, "adapter": a.adapter, "data": a.data, "max_tokens": a.max_tokens,
              "decoding": "greedy (temp 0)", "seconds": round(time.time() - t0, 1), **metrics(rows),
              "examples": rows}
    out = Path(a.out_dir) / f"{a.name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("overall", "per_signal")}, indent=1))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
