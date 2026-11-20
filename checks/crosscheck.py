"""Advisory cross-check of Qwen's scenario extraction (Danny).

POST /api/interpret/check compares the scenario Qwen extracted with two independent signals:
  1. Grounding: does each extracted number literally appear in the incident text? (no model, instant)
  2. A second opinion from Akamai's Gemma model (VISION_MODEL), asked to extract the same fields.

Advisory only: it never changes the scenario or anything downstream. Two models agreeing is not proof;
a disagreement is the useful signal, and it is shown so a person can check that field in Configure.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()

DEFAULT_VISION_MODEL = "gemma-4-26b-a4b-it"
TIMEOUT_S = 25.0

# (key used by Qwen's interpret schema, path in the Scenario, label for people)
FIELDS: list[tuple[str, str, str]] = [
    ("arrivals_rps", "arrivals_rps", "Arrivals / s"),
    ("payments_capacity_rps", "capacities.payments_rps", "Payments capacity / s"),
    ("fault_start_tick", "fault.start_tick", "Fault starts (s)"),
    ("fault_end_tick", "fault.end_tick", "Fault ends (s)"),
    ("fault_capacity_rps", "fault.capacity_rps", "Capacity during fault / s"),
    ("max_retries", "retry.max_retries", "Max retries"),
    ("ticks", "ticks", "Duration (s)"),
]

GEMMA_PROMPT = (
    "Extract these numbers from the incident report. Reply with one JSON object only, no prose, no code fences. "
    "Keys: arrivals_rps, payments_capacity_rps, fault_start_tick, fault_end_tick, fault_capacity_rps, max_retries, ticks. "
    "Units: requests per second, and seconds for ticks. Use null for anything the text does not state. Do not guess.\n\n"
    "Incident report:\n"
)


class CheckRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    scenario: dict[str, Any]
    missing_fields: list[str] = []


def _get(d: dict[str, Any], path: str) -> Any:
    for part in path.split("."):
        if not isinstance(d, dict):
            return None
        d = d.get(part)
    return d


WORD_NUMBERS = {"zero": 0, "one": 1, "once": 1, "two": 2, "twice": 2, "three": 3, "four": 4, "five": 5,
                "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def numbers_in(text: str) -> set[float]:
    """Every number written in the text, e.g. '100/s', '30 rps', 'second 20 through 50', '1,000', 'two times'."""
    found = {float(v) for w, v in WORD_NUMBERS.items() if re.search(rf"\b{w}\b", text, re.I)}
    for m in re.findall(r"\d[\d,]*(?:\.\d+)?", text):
        try:
            found.add(float(m.replace(",", "")))
        except ValueError:
            pass
    return found


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_json(content: str) -> dict[str, Any]:
    content = content.strip()
    fence = re.search(r"\{.*\}", content, re.S)  # tolerate code fences or stray prose around the object
    return json.loads(fence.group(0) if fence else content)


def ask_gemma(text: str) -> dict[str, Any]:
    """Second opinion from Gemma. Returns {used, model, values, raw_response, error, latency_ms}; never raises."""
    model = os.environ.get("VISION_MODEL") or DEFAULT_VISION_MODEL
    out: dict[str, Any] = {"used": False, "model": model, "values": {}, "raw_response": None, "error": None, "latency_ms": None}
    base, key = os.environ.get("AKAMAI_BASE_URL"), os.environ.get("AKAMAI_API_KEY")
    if not base or not key:
        out["error"] = "AKAMAI_BASE_URL / AKAMAI_API_KEY not set, so Gemma was not called."
        return out
    try:
        from openai import OpenAI

        client = OpenAI(base_url=base, api_key=key, timeout=TIMEOUT_S, max_retries=0)
        started = time.monotonic()
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": GEMMA_PROMPT + text}],
            max_tokens=300,
            temperature=0,
        )
        out["latency_ms"] = round((time.monotonic() - started) * 1000)
        content = resp.choices[0].message.content or ""
        out["raw_response"] = content
        parsed = _parse_json(content)
        out["values"] = {k: parsed.get(k) for k, _, _ in FIELDS}
        out["used"] = True
    except Exception as e:  # advisory feature: report the failure, never break the page
        out["error"] = f"{e.__class__.__name__}: {str(e)[:300]}"
    return out


def cross_check(text: str, scenario: dict[str, Any], missing_fields: list[str], gemma: dict[str, Any]) -> dict[str, Any]:
    in_text = numbers_in(text)
    missing = set(missing_fields)
    rows = []
    for key, path, label in FIELDS:
        qwen = _get(scenario, path)
        q = _num(qwen)
        if key in missing:
            grounding = "default"  # Qwen did not extract it; the scenario uses a default
        elif q is None:
            grounding = "n/a"
        else:
            grounding = "found" if q in in_text else "not_found"
        g = _num(gemma["values"].get(key)) if gemma["used"] else None
        if not gemma["used"]:
            agree = None
        elif g is None and (key in missing or q is None):
            agree = True  # neither model found it in the text
        elif g is None or q is None:
            agree = False
        else:
            agree = g == q
        rows.append({"field": key, "label": label, "qwen": qwen, "grounding": grounding,
                     "gemma": gemma["values"].get(key) if gemma["used"] else None, "agree": agree})
    checked = [r for r in rows if r["grounding"] in ("found", "not_found")]
    compared = [r for r in rows if r["agree"] is not None]
    return {
        "fields": rows,
        "grounding": {"checked": len(checked), "found": sum(r["grounding"] == "found" for r in checked)},
        "agreement": {"compared": len(compared), "agree": sum(bool(r["agree"]) for r in compared)},
        "gemma": {k: gemma[k] for k in ("used", "model", "raw_response", "error", "latency_ms")},
        "advisory": True,
        "note": "Advisory only. The scenario is not changed; fix any flagged field yourself in Scenario configuration.",
    }


@router.post("/api/interpret/check")
def interpret_check(body: CheckRequest):
    return cross_check(body.text, body.scenario, body.missing_fields, ask_gemma(body.text))
