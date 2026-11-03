import json
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "acceptance"))
import check_experiment as ce  # noqa: E402
import check_research as cr  # noqa: E402
import rank  # noqa: E402
import verdict as v  # noqa: E402

PRED = {"experiment": "E-001", "primary_metric": "repos_per_visit", "rung": "costly_action", "predicted_rate": 0.02, "min_worthwhile_rate": 0.01,
        "min_exposure": 150, "max_exposure": 1000, "deadline_days": 45}


def res(n, k):
    return {"qualified_visits": n, "primary_successes": k}


def test_wilson_matches_spec_appendix():
    lo, hi = v.wilson(3, 412)
    assert round(lo, 4) == 0.0035 and round(hi, 4) == 0.0149


def test_inconclusive_example_from_spec():
    r = v.decide(PRED, res(412, 3), 20, True)
    assert r["result"] == "inconclusive" and r["action"] == "continue"


def test_pass():
    assert v.decide(PRED, res(400, 40), 20, True)["result"] == "pass"


def test_fail():
    assert v.decide(PRED, res(900, 0), 20, True)["result"] == "fail"


def test_no_signal_only_at_deadline():
    assert v.decide(PRED, res(40, 1), 20, True)["result"] == "continue"
    assert v.decide(PRED, res(40, 1), 45, True)["result"] == "no_signal"


def test_void_without_preregistration():
    assert v.decide(PRED, res(400, 40), 20, False)["result"] == "void"


def test_inconclusive_at_cap_is_kill_flagged():
    r = v.decide(PRED, res(1000, 10), 20, True)
    assert r["result"] == "inconclusive" and r["action"] == "kill_flagged"


def rec(i, dom="a.com", **kw):
    r = {"source_url": f"https://{dom}/p{i}", "retrieved_on": "2026-11-03", "hypothesis": "H-1", "who": "dev",
         "pain": "hits usage limits", "workaround": "switches chat", "spend_evidence": "money",
         "frequency": "recurring"}
    r.update(kw)
    return r


def test_record_rules():
    assert cr.check_record(rec(1), "x") == []
    assert cr.check_record(rec(1, pain="mail me bob@x.io"), "x")
    assert cr.check_record(rec(1, excerpt="one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"), "x")
    assert cr.check_record(rec(1, source_type="persona"), "x")
    assert cr.check_record(rec(1, frequency="sometimes"), "x")


def write_signals(root, recs):
    d = root / "research" / "signals"
    d.mkdir(parents=True)
    (d / "s.jsonl").write_text("\n".join(json.dumps(r) for r in recs))


def test_aggregate_domain_cap(tmp_path):
    write_signals(tmp_path, [rec(i, "a.com") for i in range(10)] + [rec(i, "b.com") for i in range(3)]
                  + [rec(i, "c.com") for i in range(3)])
    assert any("40%" in e for e in cr.aggregate(tmp_path))


def test_rank_and_verify(tmp_path):
    recs = [rec(i, ["a.com", "b.com", "c.com"][i % 3]) for i in range(15)]
    recs += [rec(i, ["a.com", "b.com", "c.com"][i % 3], hypothesis="H-2", spend_evidence="none") for i in range(15)]
    recs += [rec(i, hypothesis="H-3") for i in range(5)]
    write_signals(tmp_path, recs)
    (tmp_path / "research" / "rank_inputs.yaml").write_text(yaml.dump(
        {h: {"reachability": 3, "team_edge": 3, "build_days": 7} for h in ("H-1", "H-2", "H-3")}))
    out = rank.compute(tmp_path)
    assert out["top"][0]["hypothesis"] == "H-1" and out["insufficient"] == ["H-3"]
    assert rank.main(["--root", str(tmp_path), "--verify"]) == 1  # not written yet
    rank.main(["--root", str(tmp_path), "--write"])
    assert rank.main(["--root", str(tmp_path), "--verify"]) == 1  # only 2 sufficient (<3)


GOOD = """<html><body><h1>Run big projects</h1>
<p>Early access pilot.</p>
<div data-honesty>Status: in progress. Expected: 2026-12-01. Nothing is charged.</div>
<div data-privacy-notice>Privacy</div><label data-consent><input type=checkbox></label>
<div data-disclosure>Built by a small team.</div>
<script>const u="MARKET_WORKER_URL";</script></body></html>"""


def make_exp(tmp, html=GOOD, kill=None):
    d = tmp / "E-001"
    (d / "site").mkdir(parents=True)
    (d / "prediction.yaml").write_text(yaml.dump(PRED))
    (d / "kill.yaml").write_text(yaml.dump(kill or {"stop_if": [{"spend_exceeds_usd": 0}, {"days_elapsed": 45}]}))
    (d / "hypothesis.md").write_text("For devs, usage limits matter enough that they will submit a repo.\n")
    (d / "site" / "index.html").write_text(html)
    return d


def test_experiment_ok(tmp_path):
    assert ce.check(make_exp(tmp_path)) == []


@pytest.mark.parametrize("bad", [
    GOOD + "<a href='https://buy.stripe.com/x'>pay</a>",
    GOOD + "<script src='https://www.googletagmanager.com/gtag/js'></script>",
    GOOD + "<p>Trusted by 500 teams</p>",
    GOOD.replace("Nothing is charged.", ""),
    GOOD.replace("data-consent", "data-x"),
])
def test_experiment_rejects(tmp_path, bad):
    assert ce.check(make_exp(tmp_path, bad))


def test_experiment_needs_zero_spend_kill(tmp_path):
    assert ce.check(make_exp(tmp_path, kill={"stop_if": [{"days_elapsed": 45}]}))


def test_ai_disclosure(tmp_path):
    d = make_exp(tmp_path)
    (d / "interviewer.yaml").write_text("questions: []")
    assert ce.check(d)
    (d / "site" / "index.html").write_text(GOOD + "<div data-ai-disclosure>You are chatting with an AI.</div>")
    assert ce.check(d) == []


def test_rank_check_mode(tmp_path):
    recs = []
    for h in ("H-1", "H-2", "H-3"):
        recs += [rec(i, ["a.com", "b.com", "c.com"][i % 3], hypothesis=h) for i in range(15)]
    write_signals(tmp_path, recs)
    (tmp_path / "research" / "rank_inputs.yaml").write_text(yaml.dump(
        {h: {"reachability": 3, "team_edge": 3, "build_days": 7} for h in ("H-1", "H-2", "H-3")}))
    assert rank.main(["--root", str(tmp_path), "--check"]) == 0
