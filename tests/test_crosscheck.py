"""Advisory Gemma cross-check (checks/crosscheck.py). No network: Gemma is faked."""
from checks import crosscheck as cc
from cascadeiq.engine.models import default_demo_scenario

TEXT = ("Arrivals are about 80 requests per second. Payments normally handles 100/s "
        "but falls to roughly 30/s from second 20 through 50. Clients retry immediately up to two times.")


def scenario():
    return default_demo_scenario().model_dump(mode="json")


def gemma(values, used=True):
    return {"used": used, "model": "gemma-4-26b-a4b-it", "values": values, "raw_response": "{}", "error": None if used else "x", "latency_ms": 5}


def row(res, key):
    return next(r for r in res["fields"] if r["field"] == key)


def test_numbers_in_text():
    assert {80.0, 100.0, 30.0, 20.0, 50.0} <= cc.numbers_in(TEXT)
    assert 1000.0 in cc.numbers_in("about 1,000 req/s")
    assert 2.0 in cc.numbers_in("Clients retry up to two times")


def test_grounding_flags_numbers_missing_from_text():
    sc = scenario()
    sc["fault"]["capacity_rps"] = 25  # not written anywhere in TEXT
    res = cc.cross_check(TEXT, sc, ["max_retries", "ticks"], gemma({}, used=False))
    assert row(res, "arrivals_rps")["grounding"] == "found"
    assert row(res, "fault_capacity_rps")["grounding"] == "not_found"
    assert row(res, "max_retries")["grounding"] == "default"   # listed as missing by Qwen, so the scenario used a default
    assert res["gemma"]["used"] is False and row(res, "arrivals_rps")["agree"] is None


def test_agreement_and_disagreement_with_gemma():
    sc = scenario()
    g = gemma({"arrivals_rps": 80, "payments_capacity_rps": 100, "fault_start_tick": 20, "fault_end_tick": 50,
               "fault_capacity_rps": 35, "max_retries": 2, "ticks": None})
    res = cc.cross_check(TEXT, sc, ["ticks"], g)
    assert row(res, "arrivals_rps")["agree"] is True
    assert row(res, "fault_capacity_rps")["agree"] is False   # Gemma read 35, Qwen 30
    assert row(res, "ticks")["agree"] is True                 # neither found a duration in the text
    assert res["agreement"] == {"compared": 7, "agree": 6}


def test_never_changes_scenario():
    sc = scenario()
    before = dict(sc)
    cc.cross_check(TEXT, sc, [], gemma({"arrivals_rps": 999}))
    assert sc == before


def test_gemma_without_key_reports_instead_of_raising(monkeypatch):
    monkeypatch.delenv("AKAMAI_BASE_URL", raising=False)
    monkeypatch.delenv("AKAMAI_API_KEY", raising=False)
    out = cc.ask_gemma(TEXT)
    assert out["used"] is False and "not set" in out["error"]


def test_parses_fenced_json():
    assert cc._parse_json('```json\n{"arrivals_rps": 80}\n```') == {"arrivals_rps": 80}
