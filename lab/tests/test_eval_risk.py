import json
import unittest

from src import eval_risk as er


def row(gold_risk, gold_signals, text, source="mainnet"):
    return {"source": source, "gold": {"risk": gold_risk, "signals": gold_signals}, "pred": er.parse_answer(text)}


class ParseAnswer(unittest.TestCase):
    def test_risk_format(self):
        p = er.parse_answer('{"risk":"high","signals":["recipient_mismatch"],"reasons":["x"]}')
        self.assertEqual(p, {"risk": "high", "signals": ["recipient_mismatch"], "format": "risk"})

    def test_risk_in_code_fence_with_prose(self):
        p = er.parse_answer('Sure:\n```json\n{"risk":"LOW","signals":[]}\n```')
        self.assertEqual((p["risk"], p["format"]), ("low", "risk"))

    def test_legacy_decision(self):
        for d, risk in (("BLOCK", "high"), ("review", "high"), ("ALLOW", "low")):
            p = er.parse_answer(json.dumps({"decision": d, "confidence": 1.0, "reasons": [], "evidence_fields": []}))
            self.assertEqual((p["risk"], p["format"], p["signals"]), (risk, "decision", []))

    def test_invalid(self):
        for t in ("", "ALLOW", '{"risk":"medium"}', '{"decision":"MAYBE"}', "[1,2]", '{"risk": "high"'):
            self.assertEqual(er.parse_answer(t)["format"], "invalid", t)
            self.assertIsNone(er.parse_answer(t)["risk"])

    def test_signals_not_a_list(self):
        self.assertEqual(er.parse_answer('{"risk":"high","signals":"x"}')["signals"], [])

    def test_expected_of(self):
        ex = {"messages": [{}, {}, {"role": "assistant", "content": '{"risk":"high","signals":["undeclared_close"],"reasons":[]}'}]}
        self.assertEqual(er.expected_of(ex), {"risk": "high", "signals": ["undeclared_close"]})


class Metrics(unittest.TestCase):
    def test_wilson(self):
        self.assertEqual(er.wilson(0, 0), (None, None))
        lo, hi = er.wilson(8, 10)
        self.assertAlmostEqual(lo, 0.4902, places=3)
        self.assertAlmostEqual(hi, 0.9433, places=3)
        self.assertEqual(er.wilson(10, 10)[1], 1.0)
        self.assertGreater(er.wilson(0, 10)[1], 0)

    def test_summary_counts(self):
        rows = [row("high", ["recipient_mismatch"], '{"risk":"high","signals":["recipient_mismatch"]}'),
                row("high", ["amount_understated"], '{"risk":"low","signals":[]}'),
                row("high", ["amount_understated"], "garbage"),
                row("low", [], '{"decision":"BLOCK"}'),
                row("low", [], '{"risk":"low","signals":[]}', source="synthetic")]
        m = er.metrics(rows)
        o = m["overall"]
        self.assertEqual((o["n"], o["tp"], o["fp"], o["fn"], o["invalid"]), (5, 1, 1, 2, 1))
        self.assertEqual(o["accuracy"], 0.4)
        self.assertEqual(o["invalid_rate"], 0.2)
        self.assertEqual(o["high_precision"], 0.5)
        self.assertEqual(o["high_recall"], 0.3333)
        self.assertEqual(o["high_f1"], 0.4)
        self.assertEqual(o["formats"], {"risk": 3, "decision": 1, "invalid": 1})
        ps = m["per_signal"]
        self.assertEqual(ps["recipient_mismatch"]["recall"], 1.0)
        self.assertEqual(ps["recipient_mismatch"]["named"], 1.0)
        self.assertEqual((ps["amount_understated"]["n"], ps["amount_understated"]["recall"]), (2, 0.0))
        self.assertEqual((ps["none"]["n"], ps["none"]["specificity"]), (2, 0.5))
        self.assertEqual(set(m["per_source"]), {"mainnet", "synthetic"})
        self.assertEqual(m["per_source"]["synthetic"]["accuracy"], 1.0)

    def test_detected_but_unnamed_signal(self):
        m = er.metrics([row("high", ["injected_instruction"], '{"decision":"BLOCK"}')])
        s = m["per_signal"]["injected_instruction"]
        self.assertEqual((s["recall"], s["named"]), (1.0, 0.0))

    def test_no_predicted_high(self):
        o = er.metrics([row("low", [], '{"risk":"low"}')])["overall"]
        self.assertIsNone(o["high_precision"])
        self.assertIsNone(o["high_recall"])
        self.assertIsNone(o["high_f1"])


if __name__ == "__main__":
    unittest.main()
