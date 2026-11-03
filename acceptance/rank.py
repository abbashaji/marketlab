#!/usr/bin/env python3
"""Hypothesis ranking (spec 7.3). Usage: rank.py [--root .] [--check | --write | --verify]

Reads research/signals/*.jsonl and research/rank_inputs.yaml; computes research/ranking.json.
--verify exits 1 if the committed ranking.json differs from the computed one.
Weights: pain 20, spend 25, workaround 15, reach 15, competition gap 10, team edge 10, build time 5.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import yaml

W = {"pain_frequency": 20, "spend_evidence": 25, "workaround": 15, "reachability": 15,
     "competition_gap": 10, "team_edge": 10, "build_time": 5}
MIN_SIGNALS, MIN_DOMAINS = 15, 3
STRENGTH = {"money": 4, "time": 3}


def domain(url: str) -> str:
    return url.split("//", 1)[-1].split("/", 1)[0].lower().removeprefix("www.")


def strength(s: dict) -> int:
    sp = s.get("spend_evidence", "none")
    if sp in STRENGTH:
        return STRENGTH[sp]
    return 2 if str(s.get("workaround", "none")).strip().lower() not in ("", "none") else 1


def load_signals(root: Path):
    by = defaultdict(list)
    for f in sorted((root / "research" / "signals").glob("*.jsonl")):
        for line in f.read_text().splitlines():
            if line.strip():
                s = json.loads(line)
                if s.get("source_type") == "persona":
                    continue  # simulated personas contribute 0
                by[s["hypothesis"]].append(s)
    return by


def share(items, pred):
    return sum(1 for s in items if pred(s)) / len(items) if items else 0.0


def score(h: str, sigs: list, inp: dict) -> dict:
    doms = {domain(s["source_url"]) for s in sigs}
    f = {
        "pain_frequency": share(sigs, lambda s: s.get("frequency") in ("recurring", "constant")),
        "spend_evidence": share(sigs, lambda s: s.get("spend_evidence") == "money"),
        "workaround": share(sigs, lambda s: str(s.get("workaround", "none")).strip().lower() not in ("", "none")),
        "reachability": min(5, max(0, float(inp.get("reachability", 0)))) / 5,
        "competition_gap": share(sigs, lambda s: bool(s.get("alt_complaint"))),
        "team_edge": min(5, max(0, float(inp.get("team_edge", 0)))) / 5,
        "build_time": min(1.0, max(0.0, 1 - float(inp.get("build_days", 30)) / 30)),
    }
    total = sum(W[k] * v for k, v in f.items())
    return {"hypothesis": h, "score": round(total, 2), "signals": len(sigs), "domains": len(doms),
            "mean_strength": round(sum(strength(s) for s in sigs) / len(sigs), 2),
            "factors": {k: round(v, 3) for k, v in f.items()},
            "insufficient": len(sigs) < MIN_SIGNALS or len(doms) < MIN_DOMAINS}


def compute(root: Path) -> dict:
    inputs = yaml.safe_load((root / "research" / "rank_inputs.yaml").read_text()) or {}
    by = load_signals(root)
    rows = [score(h, by.get(h, []), inputs.get(h, {})) for h in sorted(set(inputs) | set(by))]
    ok = sorted((r for r in rows if not r["insufficient"]), key=lambda r: (-r["score"], r["hypothesis"]))
    return {"weights": W, "top": ok[:5], "insufficient": [r["hypothesis"] for r in rows if r["insufficient"]],
            "all": rows}


def main(argv=None) -> int:
    a = list(argv if argv is not None else sys.argv[1:])
    root = Path(a[a.index("--root") + 1]) if "--root" in a else Path(".")
    out = compute(root)
    text = json.dumps(out, indent=2, sort_keys=True) + "\n"
    target = root / "research" / "ranking.json"
    if "--check" in a:  # used by cell acceptance: inputs are complete and enough hypotheses qualify
        if len(out["top"]) < 3:
            print(f"only {len(out['top'])} sufficient hypotheses; need at least 3 (insufficient: {out['insufficient']})")
            return 1
        print(f"ok: top {[r['hypothesis'] for r in out['top']]}")
    elif "--write" in a:
        target.write_text(text)
    elif "--verify" in a:
        if not target.exists() or target.read_text() != text:
            print("ranking.json missing or does not match rank.py output")
            return 1
        if len(out["top"]) < 3:
            print(f"only {len(out['top'])} sufficient hypotheses; need at least 3")
            return 1
        print(f"ok: top {len(out['top'])}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
