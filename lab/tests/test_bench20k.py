import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from src import aval_benchmark as ab
from src import bench20k as bk
from src import svm_dataset as sd
from tests.test_aval_benchmark import payer, sol_transfer, usdc_transfer


def mainnet(n=300, bots=0):
    recs = []
    for i in range(n):
        recs.append((usdc_transfer if i % 2 else sol_transfer)(f"m{i:04d}", payer(i), 10 ** 8 + i))
    recs += [sol_transfer(f"bot{i}", payer(999), 10 ** 8 + i) for i in range(bots)]
    return recs


def build(recs, **kw):
    b = bk.MainnetBuilder(**kw)
    return [c for r in recs for c in b.add(r)], b


class MainnetSets(unittest.TestCase):
    def test_sets_are_disjoint_one_case_per_record_and_capped(self):
        cases, b = build(mainnet(300, bots=30), p_attack=0.3, n_attack=40)
        by_set = Counter(c["set"] for c in cases)
        self.assertEqual(by_set["attack_real_tx"], 40)
        self.assertEqual(len({c["tx_digest"] for c in cases}), len(cases))  # one case per transaction
        self.assertEqual(b.meta()["payer_cap_dropped"], 10)                  # 30 bot records, cap 20
        for c in cases:
            self.assertEqual(c["expected"], ab.BLOCK if c["set"] == "attack_real_tx" else ab.ALLOW)
            signals, _ = sd.label(c["intent"], c["record"], c["metadata"])
            self.assertEqual(signals, c["gold_signals"])
            if c["kind"] == "injected_instruction":
                self.assertTrue(all(v in sd.TEST_ONLY_INJECTIONS for v in c["metadata"].values()))

    def test_replay_is_identical_and_ids_are_stable(self):
        a, _ = build(mainnet(200), p_attack=0.3)
        b, _ = build(mainnet(200), p_attack=0.3)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        self.assertTrue(all(c["case_id"][3:] == c["tx_digest"][:16] for c in a))

    def test_excluded_and_dust_records_are_skipped(self):
        recs = mainnet(5) + [sol_transfer("dust", payer(50), 1000)]
        cases, b = build(recs, exclude={"m0000"})
        self.assertNotIn("m0000", {c["tx_digest"] for c in cases})
        self.assertNotIn("dust", {c["tx_digest"] for c in cases})
        self.assertEqual(b.skipped["in_earlier_files"], 1)
        self.assertEqual(b.skipped["below_min_sol"], 1)


class Constructed(unittest.TestCase):
    def test_each_record_gives_a_benign_twin_and_one_attack(self):
        recs = [usdc_transfer(f"s{i}", payer(100 + i), 10 ** 6 + i, source="synthetic") for i in range(40)]
        cases, meta = bk.constructed_cases(recs)
        self.assertEqual(Counter(c["expected"] for c in cases), {ab.ALLOW: 40, ab.BLOCK: 40})
        self.assertEqual({c["set"] for c in cases}, {"attack_constructed"})
        for c in cases:
            self.assertEqual(sd.label(c["intent"], c["record"], c["metadata"])[0], c["gold_signals"])
        self.assertEqual(meta["usable"], 40)


class Streaming(unittest.TestCase):
    def test_tail_waits_for_complete_lines(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.jsonl"
            t = bk.Tail(p)
            self.assertEqual(t.read(), [])
            p.write_text('{"a":1}\n{"b"')
            self.assertEqual(t.read(), [{"a": 1}])
            self.assertFalse(t.read_pending())
            with open(p, "a") as f:
                f.write(':2}\n')
            self.assertTrue(t.read_pending())
            self.assertEqual(t.read(), [{"b": 2}])
            self.assertEqual(t.lines, 2)

    def test_model_only_raises_risk(self):
        s = bk.Summary()
        base = {"type": "decision", "set": "real_traffic", "kind": "legit:swap", "expected": ab.ALLOW, "signals": [],
                "latency_ms": {"A": 0.01, "B": 0.01}, "usd": 5.0}
        s.add({**base, "case_id": "a", "decision": ab.ALLOW, "layer": None})
        s.add({**base, "case_id": "b", "decision": ab.ALLOW, "layer": None})
        s.add({**base, "case_id": "c", "decision": ab.BLOCK, "layer": "A", "expected": ab.BLOCK})
        s.add({"type": "model", "case_id": "a", "risk": "high", "signals": ["recipient_mismatch"], "format": "risk", "latency_ms": 900})
        s.add({"type": "model", "case_id": "b", "risk": "high", "signals": ["injected_instruction"], "format": "risk", "latency_ms": 900})
        s.add({"type": "model", "case_id": "c", "risk": "low", "signals": [], "format": "risk", "latency_ms": 900})
        self.assertEqual(s.final("a"), (ab.REVIEW, "C"))
        self.assertEqual(s.final("b"), (ab.BLOCK, "C"))
        self.assertEqual(s.final("c"), (ab.BLOCK, "A"))
        rt = s.build(3)["sets"]["real_traffic"]
        self.assertEqual(rt["final"], {"BLOCK": 2, "ALLOW": 0, "REVIEW": 1})
        self.assertEqual((rt["fp"], rt["review_legit"], rt["tp"]), (1, 1, 1))
        self.assertEqual(rt["value_protected_usd"], 5.0)
        self.assertEqual(rt["model"]["progress"], 1.0)

    def test_stream_end_to_end_is_resumable(self):
        recs = mainnet(60)
        cases, _ = build(recs, p_attack=0.3)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            bk.append_lines(out / "cases.jsonl", cases[:30])
            args = ["--out", d, "--stream"]
            ab.main(args)
            bk.append_lines(out / "cases.jsonl", cases[30:])
            (out / bk.CASES_DONE).touch()
            ab.main(args)
            ab.main(args)  # nothing new: no duplicates
            events = list(sd.read_jsonl(out / "events.jsonl"))
            self.assertEqual(sorted(e["case_id"] for e in events), sorted(c["case_id"] for c in cases))
            summary = json.loads((out / "summary.json").read_text())
            self.assertTrue(summary["done"])
            self.assertEqual(sum(v["cases"] for v in summary["sets"].values()), len(cases))
            self.assertEqual(summary["sets"]["real_traffic"]["fp"], 0)
            self.assertEqual(summary["sets"]["attack_real_tx"]["fn"], 0)

    def test_model_sample_policy_counts_only_wanted_cases(self):
        policy = {"seed": 7, "sample": {"real_traffic": 0.5}}
        ids = [f"rt-{i:04d}" for i in range(400)]
        wanted = [i for i in ids if bk.model_wanted(i, "real_traffic", policy)]
        self.assertTrue(150 < len(wanted) < 250)
        self.assertTrue(all(bk.model_wanted(f"ar-{i}", "attack_real_tx", policy) for i in range(50)))
        self.assertEqual(wanted, [i for i in ids if bk.model_wanted(i, "real_traffic", policy)])  # seeded, stable
        s = bk.Summary(policy)
        for i in ids:
            s.add({"type": "decision", "case_id": i, "set": "real_traffic", "kind": "legit:swap", "expected": ab.ALLOW,
                   "decision": ab.ALLOW, "layer": None, "latency_ms": {"A": 0.01, "B": 0.01}, "usd": None})
        s.add({"type": "model", "case_id": ids[0], "risk": "low", "signals": [], "format": "risk", "latency_ms": 1})
        expected = len(set(wanted) | {ids[0]})
        self.assertEqual(s.model_expected(), expected)
        out = s.build(len(ids))
        self.assertEqual(out["model_expected"], expected)
        self.assertEqual(out["sets"]["real_traffic"]["model"]["expected"], expected)
        self.assertEqual(out["model_policy"], policy)

    def test_stratified_sample_covers_every_stratum(self):
        cases = ([{"case_id": f"r{i}", "set": "real_traffic", "expected": ab.ALLOW} for i in range(900)]
                 + [{"case_id": f"a{i}", "set": "attack_real_tx", "expected": ab.BLOCK} for i in range(100)])
        s = bk.stratified_sample(cases, 200, min_per_stratum=30)
        self.assertEqual(Counter(c["set"] for c in s), {"real_traffic": 180, "attack_real_tx": 30})
        self.assertEqual(s, bk.stratified_sample(cases, 200, min_per_stratum=30))


if __name__ == "__main__":
    unittest.main()
