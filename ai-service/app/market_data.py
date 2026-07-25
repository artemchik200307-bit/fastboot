from __future__ import annotations

import httpx

from app.models import MarketSnapshot


BASES = (
    "https://api.binance.com",
    "https://data-api.binance.vision",
)


async def _get(path: str):
    last_error: Exception | None = None

    async with httpx.AsyncClient(timeout=15) as client:
        for base in BASES:
            try:
                response = await client.get(f"{base}{path}")
                response.raise_for_status()
                return response.json()
            except Exception as error:  # noqa: BLE001
                last_error = error

    raise RuntimeError("Market data unavailable") from last_error


async def top_symbols(limit: int = 20) -> list[str]:
    rows = await _get("/api/v3/ticker/24hr")

    supported = [
        row for row in rows
        if str(row.get("symbol", "")).endswith("USDT")
        and not any(
            token in str(row.get("symbol", ""))
            for token in ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")
        )
    ]

    supported.sort(
        key=lambda row: float(row.get("quoteVolume") or 0),
        reverse=True,
    )

    priority = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    result = priority + [
        row["symbol"] for row in supported
        if row["symbol"] not in priority
    ]

    return result[:limit]


async def snapshot(symbol: str, interval: str = "15m") -> MarketSnapshot:
    ticker, klines = await _get(
        f"/api/v3/ticker/24hr?symbol={symbol}"
    ), await _get(
        f"/api/v3/klines?symbol={symbol}&interval={interval}&limit=160"
    )

    candles = [
        {
            "time": int(row[0] / 1000),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
        }
        for row in klines
    ]

    return MarketSnapshot(
        symbol=symbol,
        price=float(ticker["lastPrice"]),
        change_percent=float(ticker["priceChangePercent"]),
        quote_volume=float(ticker["quoteVolume"]),
        high=float(ticker["highPrice"]),
        low=float(ticker["lowPrice"]),
        candles=candles,
    )
