from __future__ import annotations

import json

import httpx

from app.config import settings


async def committee_summary(symbol: str, side: str, confidence: float, opinions: dict) -> str:
    if not settings.groq_api_key:
        return f"{symbol} {side}: итог сформирован агентами; Groq не настроен, используется детерминированное заключение."

    payload = {
        "model": settings.groq_model,
        "temperature": 0.2,
        "max_tokens": 350,
        "messages": [
            {
                "role": "system",
                "content": "Ты инвестиционный комитет. Пиши по-русски, кратко, без обещаний прибыли. Объясни итог, противоречия, риск и условия отмены сценария.",
            },
            {
                "role": "user",
                "content": json.dumps({"symbol": symbol, "side": side, "confidence": confidence, "agents": opinions}, ensure_ascii=False, default=str)[:14000],
            },
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=18) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {settings.groq_api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            return response.json()["choices"][0]["message"]["content"].strip()
    except Exception:
        return f"{symbol} {side}: агенты согласовали сценарий с уверенностью {confidence:.0f}%. Groq временно недоступен."
