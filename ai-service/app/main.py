from __future__ import annotations

import asyncio

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException

from app.config import settings
from app.market_data import top_symbols
from app.orchestrator import analyze_symbol
from app.storage import save_signal


app = FastAPI(
    title="FASTBOOT AI Service",
    version="6.0.0",
)

scheduler = AsyncIOScheduler()


async def run_market_scan() -> dict:
    symbols = await top_symbols(settings.max_scan_symbols)
    created: list[dict] = []

    for symbol in symbols[: settings.full_analysis_candidates]:
        try:
            signal = await analyze_symbol(symbol)

            if signal and signal.confidence >= 55:
                created.append(save_signal(signal))
        except Exception as error:  # noqa: BLE001
            print(f"{symbol} scan error: {error}")

    return {
        "symbols_checked": len(symbols),
        "signals_created": len(created),
        "signals": created,
    }


@app.on_event("startup")
async def startup() -> None:
    scheduler.add_job(
        run_market_scan,
        "interval",
        minutes=settings.scan_interval_minutes,
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "6.0.0"}


@app.post("/api/v1/scan")
async def scan() -> dict:
    return await run_market_scan()


@app.post("/api/v1/analyze/{symbol}")
async def analyze(symbol: str) -> dict:
    value = symbol.upper().replace("/", "").replace("-", "")

    if not value.endswith("USDT"):
        raise HTTPException(400, "Поддерживаются пары к USDT")

    signal = await analyze_symbol(value)

    if not signal:
        raise HTTPException(422, "Агенты не согласовали торговый сценарий")

    return save_signal(signal)
