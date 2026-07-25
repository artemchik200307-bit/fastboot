from __future__ import annotations

from copy import deepcopy
from typing import Any

from supabase import Client, create_client

from app.config import settings
from app.models import TradingSignal


_client: Client | None = None


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            settings.supabase_url,
            settings.supabase_service_role_key,
        )
    return _client


def _database_payload(signal: TradingSignal) -> dict[str, Any]:
    """Build a compact payload for Supabase.

    The generated PNG is returned to the browser, but is intentionally not
    inserted into ai_manual_signals: base64 images can make the row several
    hundred KB and may break an existing table/schema.
    """
    payload = signal.model_dump(mode="json")
    payload["status"] = "ACTIVE"

    chart = deepcopy(payload.get("chart_analysis") or {})
    chart.pop("image_base64", None)
    chart.pop("data_url", None)
    chart.pop("candles", None)
    payload["chart_analysis"] = chart
    return payload


def save_signal(signal: TradingSignal) -> dict[str, Any]:
    """Persist the signal when possible and always return full analysis.

    A temporary Supabase/schema problem must not turn a successful market
    analysis into HTTP 500. The response includes storage_saved/storage_error
    so the issue remains visible in logs and API output.
    """
    response_payload = signal.model_dump(mode="json")
    response_payload["status"] = "ACTIVE"

    try:
        client = _get_client()
        db_payload = _database_payload(signal)

        client.table("ai_manual_signals").update(
            {"status": "EXPIRED"}
        ).eq(
            "symbol", signal.symbol
        ).eq(
            "status", "ACTIVE"
        ).execute()

        result = client.table("ai_manual_signals").insert(db_payload).execute()
        response_payload["storage_saved"] = True
        if result.data and isinstance(result.data[0], dict):
            response_payload["database_id"] = result.data[0].get("id")
    except Exception as error:  # noqa: BLE001
        print(f"Supabase save error for {signal.symbol}: {type(error).__name__}: {error}")
        response_payload["storage_saved"] = False
        response_payload["storage_error"] = "Анализ выполнен, но сохранить его в Supabase не удалось."

    return response_payload
