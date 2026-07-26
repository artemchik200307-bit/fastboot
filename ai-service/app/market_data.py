from __future__ import annotations

import httpx

from app.models import MarketSnapshot

BASES = ("https://api.binance.com", "https://data-api.binance.vision")
EXCLUDED_BASE_ASSETS = {
    "USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD",
    "EUR", "GBP", "TRY", "BRL", "AUD", "RUB", "UAH", "ZAR",
}

async def _get(path: str):
    last_error: Exception | None = None
    async with httpx.AsyncClient(timeout=20) as client:
        for base in BASES:
            try:
                response = await client.get(f"{base}{path}")
                response.raise_for_status()
                return response.json()
            except Exception as error:
                last_error = error
    raise RuntimeError("Market data unavailable") from last_error

async def top_symbols(limit: int | None = None) -> list[str]:
    exchange, tickers = await _get("/api/v3/exchangeInfo"), await _get("/api/v3/ticker/24hr")
    volumes = {str(row.get("symbol")): float(row.get("quoteVolume") or 0) for row in tickers}
    symbols = []
    for row in exchange.get("symbols", []):
        symbol = str(row.get("symbol", ""))
        base = str(row.get("baseAsset", ""))
        if row.get("status") != "TRADING" or row.get("quoteAsset") != "USDT":
            continue
        if not row.get("isSpotTradingAllowed", True) or base in EXCLUDED_BASE_ASSETS:
            continue
        if any(token in symbol for token in ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")):
            continue
        symbols.append(symbol)
    symbols.sort(key=lambda value: volumes.get(value, 0), reverse=True)
    return symbols if not limit or limit <= 0 else symbols[:limit]

async def snapshot(symbol: str, interval: str = "15m") -> MarketSnapshot:
    ticker, klines = await _get(f"/api/v3/ticker/24hr?symbol={symbol}"), await _get(f"/api/v3/klines?symbol={symbol}&interval={interval}&limit=160")
    candles = [{"time": int(row[0] / 1000), "open": float(row[1]), "high": float(row[2]), "low": float(row[3]), "close": float(row[4]), "volume": float(row[5])} for row in klines]
    return MarketSnapshot(symbol=symbol, price=float(ticker["lastPrice"]), change_percent=float(ticker["priceChangePercent"]), quote_volume=float(ticker["quoteVolume"]), high=float(ticker["highPrice"]), low=float(ticker["lowPrice"]), candles=candles)


async def latest_prices(symbols: list[str] | None = None) -> dict[str, float]:
    rows = await _get("/api/v3/ticker/price")
    wanted = {str(value).upper() for value in symbols} if symbols else None
    prices: dict[str, float] = {}
    for row in rows:
        symbol = str(row.get("symbol", "")).upper()
        if wanted is not None and symbol not in wanted:
            continue
        try:
            prices[symbol] = float(row.get("price") or 0)
        except (TypeError, ValueError):
            continue
    return prices
