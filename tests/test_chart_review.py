"""Gemma chart reading (checks/chart_review.py). No network: the model call is faked."""
import base64
import types

import pytest
from fastapi import HTTPException

from checks import chart_review as cr

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()


def test_rejects_non_image_data():
    with pytest.raises(HTTPException) as e:
        cr._decode("https://example.com/chart.png")
    assert e.value.status_code == 422


def test_rejects_oversized_image(monkeypatch):
    monkeypatch.setattr(cr, "MAX_IMAGE_BYTES", 10)
    with pytest.raises(HTTPException) as e:
        cr._decode(PNG)
    assert e.value.status_code == 413


def test_no_key_reports_instead_of_raising(monkeypatch):
    monkeypatch.delenv("AKAMAI_BASE_URL", raising=False)
    monkeypatch.delenv("AKAMAI_API_KEY", raising=False)
    out = cr.chart_review(cr.ChartReview(image=PNG, fault_start=20, fault_end=50))
    assert out["used"] is False and "not set" in out["error"] and out["advisory"] is True


def test_splits_reading_and_suggestion(monkeypatch):
    monkeypatch.setenv("AKAMAI_BASE_URL", "http://fake")
    monkeypatch.setenv("AKAMAI_API_KEY", "k")
    sent = {}

    class FakeCompletions:
        def create(self, **kw):
            sent.update(kw)
            msg = types.SimpleNamespace(content="Backlog climbs during the fault and drains after.\nSuggestion: try retry backoff.")
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)])

    class FakeOpenAI:
        def __init__(self, **kw):
            self.chat = types.SimpleNamespace(completions=FakeCompletions())

    import openai
    monkeypatch.setattr(openai, "OpenAI", FakeOpenAI)
    out = cr.chart_review(cr.ChartReview(image=PNG, fault_start=20, fault_end=50, trace="after"))
    assert out["used"] is True
    assert out["text"] == "Backlog climbs during the fault and drains after."
    assert out["suggestion"] == "try retry backoff."
    parts = sent["messages"][0]["content"]
    assert parts[1]["image_url"]["url"] == PNG and "second 20 to second 50" in parts[0]["text"]
    assert "after the verified mitigation" in parts[0]["text"]
