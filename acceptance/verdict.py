#!/usr/bin/env python3
"""Deterministic verdict (spec 7.7). Usage: verdict.py exp/E-001 [--write] [--no-git]

Writes exp/E-id/verdict.json only with --write (CI). Agents cannot edit this file.
"""
import json
import math
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import yaml

Z80 = 1.2815515655446004  # two-sided 80% interval


def wilson(k: int, n: int, z: float = Z80):
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - h) / d), min(1.0, (c + h) / d))


def decide(pred: dict, res: dict, days_elapsed: int, prereg_ok: bool) -> dict:
    n = int(res.get("qualified_visits", 0))
    k = int(res.get("primary_successes", 0))
    out = {"experiment": pred.get("experiment"), "rung": pred.get("rung"),
           "exposure": n, "successes": k}
    if not prereg_ok:
        return {**out, "result": "void", "action": "archive", "rule": "preregistration_not_proven"}
    if k > n:
        return {**out, "result": "void", "action": "archive", "rule": "successes_exceed_exposure"}
    mn, mx = int(pred["min_exposure"]), int(pred["max_exposure"])
    floor, deadline = float(pred["min_worthwhile_rate"]), int(pred["deadline_days"])
    past_deadline = days_elapsed >= deadline
    rate = k / n if n else 0.0
    lo, hi = wilson(k, n)
    out.update(rate=round(rate, 4), wilson80=[round(lo, 4), round(hi, 4)])
    if n < mn:
        if past_deadline:
            return {**out, "result": "no_signal", "action": "park_and_retry_once",
                    "rule": "exposure_below_min_at_deadline"}
        return {**out, "result": "continue", "action": "wait", "rule": "exposure_below_min_before_deadline"}
    if lo >= floor:
        out.update(result="pass", action="advance", rule="lower_bound_at_least_min")
    elif hi < floor:
        out.update(result="fail", action="archive", rule="upper_bound_below_min")
    else:
        out.update(result="inconclusive", rule="lower_bound_below_min_and_upper_bound_above")
        if n >= mx or past_deadline:
            out.update(action="kill_flagged", rule=out["rule"] + "_at_cap")
        else:
            out.update(action="continue")
    out["calibration"] = {"predicted_rate": pred.get("predicted_rate"), "observed_rate": round(rate, 4)}
    return out


def _git(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


def prereg_ok(exp: Path, first_event: str | None) -> bool:
    """prediction.yaml and kill.yaml each have exactly one commit, both before the first event."""
    if not first_event:
        return True  # no events yet
    try:
        t_event = datetime.fromisoformat(str(first_event).replace("Z", "+00:00"))
        for name in ("prediction.yaml", "kill.yaml"):
            log = _git(["log", "--format=%cI", "--", str(exp / name)], exp.parent.parent).split()
            if len(log) != 1 or datetime.fromisoformat(log[0]) >= t_event:
                return False
        return True
    except Exception:
        return False


def main(argv=None) -> int:
    a = list(argv if argv is not None else sys.argv[1:])
    write, use_git = "--write" in a, "--no-git" not in a
    a = [x for x in a if not x.startswith("--")]
    if len(a) != 1:
        print("usage: verdict.py exp/E-id [--write] [--no-git]")
        return 2
    exp = Path(a[0])
    pred = yaml.safe_load((exp / "prediction.yaml").read_text())
    res = yaml.safe_load((exp / "results.yaml").read_text())
    as_of = res.get("as_of")
    started = res.get("started_on")
    as_of_d = as_of if isinstance(as_of, date) else date.fromisoformat(str(as_of))
    start_d = started if isinstance(started, date) else date.fromisoformat(str(started))
    days = (as_of_d - start_d).days
    ok = prereg_ok(exp, res.get("first_event")) if use_git else True
    verdict = decide(pred, res, days, ok)
    text = json.dumps(verdict, indent=2, sort_keys=True)
    print(text)
    if write:
        (exp / "verdict.json").write_text(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
