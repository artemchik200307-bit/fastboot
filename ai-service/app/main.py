from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.auto_trader import monitor_auto_trading, run_daily_auto_session, startup_catchup
from app.market_data import top_symbols
from app.orchestrator import analyze_symbol
from app.storage import save_signal

app = FastAPI(title="FASTBOOT AI Service", version="12.0.0")
app.add_middleware(CORSMiddleware, allow_origin_regex=r"https://.*\.onrender\.com", allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
scheduler = AsyncIOScheduler()
_auto_background_task: asyncio.Task | None = None
scan_lock = asyncio.Lock()
scan_status = {"running": False, "symbols_total": 0, "symbols_checked": 0, "signals_created": 0, "started_at": None, "finished_at": None}

async def run_market_scan() -> dict:
    if scan_lock.locked():
        return {**scan_status, "message": "Сканирование уже выполняется"}
    async with scan_lock:
        symbols = await top_symbols()
        scan_status.update({"running": True, "symbols_total": len(symbols), "symbols_checked": 0, "signals_created": 0, "started_at": datetime.now(UTC).isoformat(), "finished_at": None})
        semaphore = asyncio.Semaphore(max(1, settings.scan_concurrency))
        async def analyze_one(symbol: str):
            async with semaphore:
                try:
                    signal = await analyze_symbol(symbol)
                    if signal and signal.confidence >= settings.minimum_signal_confidence:
                        save_signal(signal)
                        scan_status["signals_created"] += 1
                except Exception as error:
                    print(f"{symbol} scan error: {error}")
                finally:
                    scan_status["symbols_checked"] += 1
        await asyncio.gather(*(analyze_one(symbol) for symbol in symbols))
        scan_status.update({"running": False, "finished_at": datetime.now(UTC).isoformat()})
        return dict(scan_status)

@app.on_event("startup")
async def startup() -> None:
    # Manual/background signal refresh can continue independently.
    scheduler.add_job(
        run_market_scan,
        "interval",
        minutes=settings.scan_interval_minutes,
        max_instances=1,
        coalesce=True,
    )

    # AUTO trading session starts exactly at 08:00 New York time.
    scheduler.add_job(
        run_daily_auto_session,
        CronTrigger(hour=8, minute=0, timezone="America/New_York"),
        id="auto_daily_0800_ny",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )

    # Server-side order/position protection + daily target monitor.
    scheduler.add_job(
        monitor_auto_trading,
        "interval",
        seconds=max(15, settings.auto_monitor_seconds),
        id="auto_trade_monitor",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()

    # If Render restarted after 08:00, do not miss the whole trading day.
    asyncio.create_task(startup_catchup())

@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "12.0.0", "scan": scan_status}

@app.get("/api/v1/scan/status")
async def get_scan_status() -> dict:
    return dict(scan_status)

@app.post("/api/v1/scan", status_code=202)
async def scan(background_tasks: BackgroundTasks) -> dict:
    if scan_lock.locked():
        return {**scan_status, "message": "Сканирование уже выполняется"}
    background_tasks.add_task(run_market_scan)
    return {"accepted": True, "message": "Запущен анализ всех доступных активных USDT-монет"}

@app.post("/api/v1/analyze/{symbol}")
async def analyze(symbol: str) -> dict:
    value = symbol.upper().replace("/", "").replace("-", "")
    if not value.endswith("USDT"):
        raise HTTPException(400, "Поддерживаются пары к USDT")
    signal = await analyze_symbol(value)
    if not signal:
        raise HTTPException(422, "Агенты не согласовали торговый сценарий")
    return save_signal(signal)


@app.post("/api/v1/auto/run")
async def run_auto_now() -> dict:
    """Start one AUTO scan in background and return immediately."""
    global _auto_background_task

    if _auto_background_task and not _auto_background_task.done():
        return {"status": "already_running"}

    _auto_background_task = asyncio.create_task(run_daily_auto_session())
    return {"status": "started"}


@app.post("/api/v1/auto/monitor")
async def monitor_auto_now() -> dict:
    """Admin/dev endpoint for testing limit fills, TP/SL/LIQ and daily target."""
    return await monitor_auto_trading()


@app.get("/api/v1/auto/status")
async def auto_status() -> dict:
    if _auto_background_task is None:
        return {"status": "idle"}
    if not _auto_background_task.done():
        return {"status": "running"}
    try:
        result = _auto_background_task.result()
        return {"status": "finished", "result": result}
    except Exception as error:  # noqa: BLE001
        return {"status": "failed", "error": f"{type(error).__name__}: {error}"}
