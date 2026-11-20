"""Qwen recommendation informed by Gemma's chart reading. No network: the Qwen call is faked."""
import pytest
from fastapi import HTTPException

from cascadeiq.engine.models import default_demo_scenario
from cascadeiq.engine.simulator import run_simulation
from cascadeiq.inference import qwen
from checks import informed_recommend as ir

NOTE = "Backlog hits its limit during the fault and drains slowly afterwards.\nSuggestion: spread retries out."


def body(note=None, fixture=False):
    sc = default_demo_scenario()
    return ir.InformedRecommendRequest(scenario=sc, audit=run_simulation(sc), use_fixture=fixture, visual_note=note)


def test_without_note_delegates_to_plain_recommend():
    out = ir.recommend_informed(body(note=None, fixture=True))
    assert out["visual_note_used"] is False and out["inference_used"] is False
    assert out["mitigation_id"] in {m["id"] for m in qwen.MITIGATION_ALLOWLIST}


def test_fixture_ignores_note():
    out = ir.recommend_informed(body(note=NOTE, fixture=True))
    assert out["visual_note_used"] is False


def test_note_is_passed_to_qwen_as_labelled_context(monkeypatch):
    seen = {}

    def fake_chat(messages, schema, name):
        seen["messages"] = messages
        return {"mitigation_id": "retry_cap_reduction", "rationale": "Metrics plus the chart reading."}

    monkeypatch.setattr(qwen, "_chat_json", fake_chat)
    out = ir.recommend_informed(body(note=NOTE))
    assert out["visual_note_used"] is True and out["inference_used"] is True
    assert out["mitigation_id"] == "retry_cap_reduction"
    user = seen["messages"][1]["content"]
    assert "may be wrong" in user and "Backlog hits its limit" in user and "Audit evidence" in user


def test_non_allowlisted_choice_is_rejected(monkeypatch):
    monkeypatch.setattr(qwen, "_chat_json", lambda m, s, n: {"mitigation_id": "add_more_servers", "rationale": "x"})
    with pytest.raises(HTTPException) as e:
        ir.recommend_informed(body(note=NOTE))
    assert e.value.status_code == 422
