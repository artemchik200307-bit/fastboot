from supabase import Client, create_client

from app.config import settings
from app.models import TradingSignal


client: Client = create_client(
    settings.supabase_url,
    settings.supabase_service_role_key,
)


def save_signal(signal: TradingSignal) -> dict:
    payload = signal.model_dump(mode="json")
    payload["status"] = "ACTIVE"

    # Старые активные сигналы по символу закрываются.
    client.table("ai_manual_signals").update(
        {"status": "EXPIRED"}
    ).eq(
        "symbol", signal.symbol
    ).eq(
        "status", "ACTIVE"
    ).execute()

    result = client.table("ai_manual_signals").insert(payload).execute()
    return result.data[0]
