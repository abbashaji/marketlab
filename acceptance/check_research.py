#!/usr/bin/env python3
"""Research gate (spec 7.1, 7.2). Usage:
  check_research.py signals research/signals/<source>.jsonl   # one file: schema, PII, excerpts
  check_research.py aggregate [--root .]                      # per-hypothesis: >=15 signals, >=3 domains, <=40% per domain
  check_research.py competitors [--root .]                    # research/competitors.md: >=10 alternatives per hypothesis
"""
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

REQUIRED = ["source_url", "retrieved_on", "hypothesis", "who", "pain", "workaround",
            "spend_evidence", "frequency"]
SPEND = {"none", "time", "money"}
FREQ = {"one-off", "recurring", "constant"}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE = re.compile(r"(?<!\d)(?:\+?\d[\s().-]?){9,}\d(?!\d)")
HANDLE = re.compile(r"(?<![\w/])@[A-Za-z0-9_]{2,}")
URL_RE = re.compile(r"^https?://[^\s/]+\.[^\s/]+")


def domain(url: str) -> str:
    return url.split("//", 1)[-1].split("/", 1)[0].lower().removeprefix("www.")


def check_record(r: dict, where: str) -> list:
    e = []
    for k in REQUIRED:
        if r.get(k) in (None, ""):
            e.append(f"{where}: missing {k}")
    if e:
        return e
    if not URL_RE.match(str(r["source_url"])):
        e.append(f"{where}: source_url is not an http(s) URL")
    try:
        date.fromisoformat(str(r["retrieved_on"]))
    except ValueError:
        e.append(f"{where}: retrieved_on must be YYYY-MM-DD")
    if r["spend_evidence"] not in SPEND:
        e.append(f"{where}: spend_evidence must be one of {sorted(SPEND)}")
    if r["frequency"] not in FREQ:
        e.append(f"{where}: frequency must be one of {sorted(FREQ)}")
    if r.get("source_type") == "persona":
        e.append(f"{where}: simulated personas are not accepted as evidence")
    ex = r.get("excerpt", "")
    if ex and len(str(ex).split()) >= 15:
        e.append(f"{where}: excerpt must be under 15 words")
    for k in ("who", "pain", "workaround", "excerpt"):
        v = str(r.get(k, ""))
        if EMAIL.search(v) or PHONE.search(v) or HANDLE.search(v):
            e.append(f"{where}: personal data pattern in {k}")
    return e


def read_signals(path: Path):
    errs, recs = [], []
    for i, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            errs.append(f"{path.name}:{i}: invalid JSON")
            continue
        errs += check_record(r, f"{path.name}:{i}")
        recs.append(r)
    if not recs:
        errs.append(f"{path.name}: no signals")
    return errs, recs


def aggregate(root: Path) -> list:
    by = defaultdict(list)
    errs = []
    files = sorted((root / "research" / "signals").glob("*.jsonl"))
    if not files:
        return ["no signal files"]
    for f in files:
        e, recs = read_signals(f)
        errs += e
        for r in recs:
            if "hypothesis" in r:
                by[r["hypothesis"]].append(r)
    for h, recs in by.items():
        c = Counter(domain(str(r.get("source_url", ""))) for r in recs)
        top, n = c.most_common(1)[0]
        if len(recs) >= 15 and len(c) >= 3 and n / len(recs) > 0.40:
            errs.append(f"{h}: domain {top} contributes {n}/{len(recs)} (>40%)")
    return errs


def competitors(root: Path) -> list:
    p = root / "research" / "competitors.md"
    if not p.exists():
        return ["research/competitors.md missing"]
    errs, cur, counts = [], None, Counter()
    for line in p.read_text().splitlines():
        m = re.match(r"^##\s+(H-\w+)", line)
        if m:
            cur = m.group(1)
            counts[cur] += 0
        elif cur and line.startswith("- "):
            if not re.search(r"https?://\S+", line):
                errs.append(f"{cur}: alternative without URL: {line[:50]}")
            if not re.search(r"price:\s*(\$|€|£|\d|no public price)", line, re.I):
                errs.append(f"{cur}: alternative without 'price:' field: {line[:50]}")
            counts[cur] += 1
    if not counts:
        errs.append("competitors.md has no '## H-xxx' sections")
    for h, n in counts.items():
        if n < 10:
            errs.append(f"{h}: {n} alternatives, need at least 10")
    return errs


def main(argv=None) -> int:
    a = list(argv if argv is not None else sys.argv[1:])
    if not a:
        print(__doc__)
        return 2
    root = Path(a[a.index("--root") + 1]) if "--root" in a else Path(".")
    mode = a[0]
    if mode == "signals":
        errs, _ = read_signals(Path(a[1]))
    elif mode == "aggregate":
        errs = aggregate(root)
    elif mode == "competitors":
        errs = competitors(root)
    else:
        print(__doc__)
        return 2
    for e in errs[:30]:
        print("ERROR " + e)
    print("OK" if not errs else f"FAIL: {len(errs)} error(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
