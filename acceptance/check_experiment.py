#!/usr/bin/env python3
"""Experiment gate (spec 7.4). Usage: check_experiment.py exp/E-001 | exp/_template

Rules: 1 prediction/kill schema, 2 honesty block, 3 page hygiene (no trackers/payments, privacy+consent),
4 AI disclosure, 5 no unsourced testimonials/counts. Rule 6 (paths) is enforced by allowed_paths.
"""
import re
import sys
from pathlib import Path

import yaml

NUM = ("predicted_rate", "min_worthwhile_rate", "min_exposure", "max_exposure", "deadline_days")
PAYMENT = re.compile(r"stripe|paypal|gumroad|paddle|lemonsqueezy|buy\s*now|checkout|add to cart|"
                     r"pay\s*now|ko-fi|patreon|razorpay", re.I)
TRACKERS = re.compile(r"google-analytics|googletagmanager|gtag\(|fbq\(|facebook\.net|hotjar|segment\.com|"
                      r"mixpanel|plausible|posthog|clarity\.ms|doubleclick", re.I)
EARLY = re.compile(r"early access|pilot|waitlist|wait list", re.I)
CLAIM = re.compile(r"testimonial|trusted by|as seen (in|on)|\b\d[\d,]*\+?\s+(users|customers|developers|teams|"
                   r"companies|stars)\b|\bloved by\b|\b\d(\.\d)?/5\b", re.I)
EXT_SRC = re.compile(r"""(?:src|href|action)\s*=\s*["'](https?:)?//([^"'/\s]+)""", re.I)
HONESTY_NEEDS = ("status", "expected", "nothing is charged")


def check(exp: Path) -> list:
    e = []
    tmpl = exp.name.startswith("_")
    try:
        pred = yaml.safe_load((exp / "prediction.yaml").read_text()) or {}
        for k in NUM:
            if not isinstance(pred.get(k), (int, float)) or isinstance(pred.get(k), bool):
                e.append(f"prediction.yaml: {k} must be numeric")
        for k in ("primary_metric", "rung", "experiment"):
            if not pred.get(k):
                e.append(f"prediction.yaml: missing {k}")
        if not e:
            if pred["min_exposure"] > pred["max_exposure"]:
                e.append("prediction.yaml: min_exposure > max_exposure")
            if not (0 < pred["min_worthwhile_rate"] <= 1 and 0 < pred["predicted_rate"] <= 1):
                e.append("prediction.yaml: rates must be in (0, 1]")
            if pred["rung"] == "money":
                e.append("prediction.yaml: rung 'money' is not allowed (free rule)")
    except Exception as ex:
        e.append(f"prediction.yaml unreadable: {ex}")
    try:
        kill = yaml.safe_load((exp / "kill.yaml").read_text()) or {}
        stops = kill.get("stop_if") or []
        if not any(isinstance(s, dict) and s.get("spend_exceeds_usd") == 0 for s in stops):
            e.append("kill.yaml: stop_if must contain spend_exceeds_usd: 0")
        if not any(isinstance(s, dict) and "days_elapsed" in s for s in stops):
            e.append("kill.yaml: stop_if must contain days_elapsed")
    except Exception as ex:
        e.append(f"kill.yaml unreadable: {ex}")
    hyp = exp / "hypothesis.md"
    if not hyp.exists() or not re.search(r"^For .+ will ", hyp.read_text(), re.M | re.S):
        e.append("hypothesis.md missing or not in the form 'For [segment], [problem] ... will [action]'")
    page = exp / "site" / "index.html"
    if not page.exists():
        return e + ["site/index.html missing"]
    html = page.read_text()
    if PAYMENT.search(html):
        e.append("page: payment link or payment wording found")
    if TRACKERS.search(html):
        e.append("page: third-party tracker found")
    for _, host in EXT_SRC.findall(html):
        if host not in ("localhost",):
            e.append(f"page: external resource/host {host} (only first-party + MARKET_WORKER_URL allowed)")
    for attr, label in (("data-privacy-notice", "privacy notice"), ("data-consent", "consent control"),
                        ("data-disclosure", "disclosure block")):
        if attr not in html:
            e.append(f"page: missing {label} ({attr})")
    if "MARKET_WORKER_URL" not in html:
        e.append("page: tracking snippet must read MARKET_WORKER_URL")
    if EARLY.search(html) and not tmpl:
        m = re.search(r"data-honesty[^>]*>(.*?)</", html, re.S | re.I)
        block = (m.group(1) if m else "").lower()
        if not all(w in block for w in HONESTY_NEEDS):
            e.append("page: early access/pilot/waitlist needs data-honesty block with status, expected date, 'nothing is charged'")
    if (exp / "interviewer.yaml").exists():
        m = re.search(r"data-ai-disclosure[^>]*>(.*?)</", html, re.S | re.I)
        if not m or not re.search(r"\bAI\b", m.group(1)):
            e.append("page: interviewer present but no data-ai-disclosure mentioning AI")
    for m in CLAIM.finditer(html):
        ctx = html[max(0, m.start() - 200): m.end() + 200]
        s = re.search(r'data-source\s*=\s*"([^"]+)"', ctx)
        if not s or not (exp / s.group(1)).exists():
            e.append(f"page: unsourced claim '{m.group(0)}' (needs data-source=<file in exp dir>)")
    return e


def main(argv=None) -> int:
    a = list(argv if argv is not None else sys.argv[1:])
    if len(a) != 1:
        print(__doc__)
        return 2
    errs = check(Path(a[0]))
    for x in errs[:30]:
        print("ERROR " + x)
    print("OK" if not errs else f"FAIL: {len(errs)} error(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
