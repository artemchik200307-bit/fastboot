from __future__ import annotations


async def committee_summary(symbol: str, side: str, confidence: float, opinions: dict) -> str:
    supporters = [
        value for value in opinions.values()
        if value.get("direction") == side
    ]
    key_points = [
        str(value.get("summary") or "").strip()
        for value in supporters
        if str(value.get("summary") or "").strip()
    ][:3]
    details = " ".join(key_points)
    base = f"{symbol} {side}: {len(supporters)} агентов поддержали сценарий, уверенность {confidence:.0f}%."
    return f"{base} {details}".strip()
