"""Gemma reads the simulation chart (Danny).

POST /api/chart/review sends a PNG of the dashboard's time-series chart to Akamai's vision model (Gemma)
and returns a short plain-language reading plus one simple suggestion.

Advisory only: it does not change the scenario, the audit or the verification. Whether a fix works is
decided by the simulator, not by this text.
"""
from __future__ import annotations

import base64
import os
import re
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

DEFAULT_VISION_MODEL = "gemma-4-26b-a4b-it"
TIMEOUT_S = 30.0
MAX_IMAGE_BYTES = 1_500_000
DATA_URL = re.compile(r"^data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)$")

PROMPT = (
    "You are looking at a chart from a simulated checkout outage in a teaching lab; nothing real failed. "
    "Lines: green = Payments throughput (requests per second), amber = backlog (queued requests), "
    "red = customers failing per second, grey dashed = Payments capacity. "
    "The red hatched band is the fault window, from second {start} to second {end}. "
    "This chart shows the run {trace}. "
    "In at most three short sentences, say what the chart shows, in plain words a student understands. "
    "Then give exactly one simple suggestion a student could try next, on its own line starting with 'Suggestion:'. "
    "Only describe what is visible. Do not invent exact numbers."
)


class ChartReview(BaseModel):
    image: str = Field(description="data:image/png;base64,... of the chart")
    fault_start: int = Field(ge=0, le=10_000)
    fault_end: int = Field(ge=0, le=10_000)
    trace: Literal["before", "after"] = "before"


def _decode(image: str) -> str:
    m = DATA_URL.match(image.strip())
    if not m:
        raise HTTPException(422, "image must be a base64 PNG or JPEG data URL")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except ValueError:
        raise HTTPException(422, "image is not valid base64")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"image is larger than {MAX_IMAGE_BYTES} bytes")
    return image.strip()


def ask_gemma_about_chart(image_url: str, prompt: str) -> dict:
    """Returns {used, model, text, suggestion, error, latency_ms}; never raises."""
    model = os.environ.get("VISION_MODEL") or DEFAULT_VISION_MODEL
    out = {"used": False, "model": model, "text": None, "suggestion": None, "error": None, "latency_ms": None}
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
            messages=[{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_url}},
            ]}],
            max_tokens=250,
            temperature=0.2,
        )
        out["latency_ms"] = round((time.monotonic() - started) * 1000)
        text = (resp.choices[0].message.content or "").strip()
        m = re.search(r"suggestion\s*:\s*(.+)", text, re.I | re.S)
        out["suggestion"] = m.group(1).strip() if m else None
        out["text"] = text[: m.start()].strip() if m else text
        out["used"] = bool(text)
        if not text:
            out["error"] = "Gemma returned an empty answer."
    except Exception as e:  # advisory feature: report the failure, never break the page
        out["error"] = f"{e.__class__.__name__}: {str(e)[:300]}"
    return out


@router.post("/api/chart/review")
def chart_review(body: ChartReview):
    image = _decode(body.image)
    trace = "before any mitigation (immediate retries)" if body.trace == "before" else "after the verified mitigation"
    prompt = PROMPT.format(start=body.fault_start, end=body.fault_end, trace=trace)
    result = ask_gemma_about_chart(image, prompt)
    return {**result, "advisory": True,
            "note": "Gemma's reading is advisory. The simulator, not the model, decides whether a fix works."}
