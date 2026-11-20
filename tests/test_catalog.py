"""Catalog endpoint — published Linode prices only; never invent."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from cascadeiq.api.catalog import fetch_compute_catalog
from cascadeiq.api.main import app
from fastapi.testclient import TestClient


SAMPLE_TYPES = {
    "data": [
        {
            "id": "g6-standard-2",
            "label": "Linode 4GB",
            "vcpus": 2,
            "memory": 4096,
            "disk": 81920,
            "transfer": 4,
            "class": "standard",
            "price": {"hourly": 0.036, "monthly": 24.0},
            "region_prices": [
                {"id": "id-cgk", "hourly": 0.04, "monthly": 28.0},
            ],
        },
        {
            "id": "g6-nanode-1",
            "label": "Nanode 1GB",
            "vcpus": 1,
            "memory": 1024,
            "disk": 25600,
            "transfer": 1,
            "class": "nanode",
            "price": {"hourly": 0.0075, "monthly": 5.0},
            "region_prices": [
                {"id": "us-sea", "hourly": 0.008, "monthly": 6.0},
            ],
        },
    ],
    "pages": 1,
    "page": 1,
    "results": 2,
}


def test_fetch_prefers_us_sea_region_prices():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = SAMPLE_TYPES
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.__exit__.return_value = False
    mock_client.get.return_value = mock_resp

    with patch("cascadeiq.api.catalog.httpx.Client", return_value=mock_client):
        out = fetch_compute_catalog(region="us-sea")

    assert out["source"] == "live"
    assert out["region"] == "us-sea"
    by_id = {t["id"]: t for t in out["types"]}
    assert by_id["g6-nanode-1"]["monthly"] == 6.0
    assert by_id["g6-nanode-1"]["price_region"] == "us-sea"
    # no us-sea entry → global published price, not invented
    assert by_id["g6-standard-2"]["monthly"] == 24.0
    assert by_id["g6-standard-2"]["price_region"] == "global"


def test_fetch_unavailable_on_error():
    with patch(
        "cascadeiq.api.catalog.httpx.Client",
        side_effect=RuntimeError("blocked"),
    ):
        out = fetch_compute_catalog(region="us-sea")
    assert out["source"] == "unavailable"
    assert out["types"] == []
    assert "blocked" in (out["message"] or "")


def test_api_catalog_route_live():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = SAMPLE_TYPES
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.__exit__.return_value = False
    mock_client.get.return_value = mock_resp

    with patch("cascadeiq.api.catalog.httpx.Client", return_value=mock_client):
        client = TestClient(app)
        res = client.get("/api/catalog/compute?region=us-sea")
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "live"
    assert len(body["types"]) == 2
