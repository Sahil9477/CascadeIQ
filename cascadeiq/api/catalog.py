"""Linode compute type catalog — published prices only, never invented."""

from __future__ import annotations

import os
from typing import Any

import httpx

LINODE_TYPES_URL = "https://api.linode.com/v4/linode/types"
DEFAULT_REGION = "us-sea"
FETCH_TIMEOUT_S = 8.0


def _pick_price(type_obj: dict[str, Any], region: str) -> dict[str, float | None]:
    """Prefer region_prices for `region` when present; else global published price."""
    for rp in type_obj.get("region_prices") or []:
        if rp.get("id") == region:
            return {
                "hourly": rp.get("hourly"),
                "monthly": rp.get("monthly"),
            }
    price = type_obj.get("price") or {}
    return {
        "hourly": price.get("hourly"),
        "monthly": price.get("monthly"),
    }


def _normalize_type(type_obj: dict[str, Any], region: str) -> dict[str, Any]:
    picked = _pick_price(type_obj, region)
    return {
        "id": type_obj.get("id"),
        "label": type_obj.get("label"),
        "vcpus": type_obj.get("vcpus"),
        "memory_mb": type_obj.get("memory"),
        "disk_mb": type_obj.get("disk"),
        "transfer_tb": type_obj.get("transfer"),
        "class": type_obj.get("class"),
        "hourly": picked["hourly"],
        "monthly": picked["monthly"],
        "price_region": region
        if any(rp.get("id") == region for rp in (type_obj.get("region_prices") or []))
        else "global",
    }


def fetch_compute_catalog(region: str = DEFAULT_REGION) -> dict[str, Any]:
    """Fetch Linode types. Returns source=live on success, unavailable on failure.

    Never invents prices — missing fields stay null; failures return empty types.
    """
    region = (region or DEFAULT_REGION).strip() or DEFAULT_REGION
    headers: dict[str, str] = {"Accept": "application/json"}
    token = os.getenv("LINODE_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        with httpx.Client(timeout=FETCH_TIMEOUT_S) as client:
            page = 1
            types: list[dict[str, Any]] = []
            while True:
                resp = client.get(
                    LINODE_TYPES_URL,
                    params={"page": page, "page_size": 100},
                    headers=headers,
                )
                resp.raise_for_status()
                payload = resp.json()
                batch = payload.get("data") or []
                types.extend(_normalize_type(t, region) for t in batch)
                pages = int(payload.get("pages") or 1)
                if page >= pages:
                    break
                page += 1

        # Drop entries with no published monthly/hourly at all
        priced = [
            t
            for t in types
            if t.get("monthly") is not None or t.get("hourly") is not None
        ]
        return {
            "region": region,
            "source": "live",
            "types": priced,
            "message": None,
        }
    except Exception as exc:  # noqa: BLE001 — demo must stay up
        return {
            "region": region,
            "source": "unavailable",
            "types": [],
            "message": f"Linode types API unavailable: {exc}",
        }
