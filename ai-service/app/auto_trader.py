from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from app.config import settings
from app.market_data import latest_prices, top_symbols
from app.orchestrator import analyze_symbol
from app.storage import get_service_client, save_signal

NY = ZoneInfo("America/New_York")
AUTO_MODE = "AUTO"
AI_SOURCE = "AI"
BOT_WALLET = "BOT"

_auto_scan_lock = asyncio.Lock()
_monitor_lock = asyncio.Lock()


async def _db_call(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


async def _select(table: str, columns: str = "*", **equals):
    client = get_service_client()
    query = client.table(table).select(columns)
    for key, value in equals.items():
        query = query.eq(key, value)
    result = await _db_call(query.execute)
    return result.data or []


async def _rpc(name: str, params: dict):
    client = get_service_client()
    result = await _db_call(client.rpc(name, params).execute)
    return result.data


def _as_float(value, default=0.0) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return default


async def _active_accounts() -> list[dict]:
    rows = await _select(
        "ai_bot_accounts",
        "user_id,is_active,initial_balance,session_date,session_start_equity,"
        "daily_target_equity,daily_target_amount,trading_locked,last_scan_at",
        is_active=True,
    )
    return [row for row in rows if row.get("user_id")]


async def _bot_equities(user_ids: set[str], prices: dict[str, float]) -> dict[str, float]:
    if not user_ids:
        return {}

    client = get_service_client()
    wallets_q = client.table("wallets").select("user_id,bot_balance").in_("user_id", list(user_ids))
    pos_q = (
        client.table("terminal_positions")
        .select("user_id,symbol,side,entry_price,quantity,margin,status,wallet_source,trade_source")
        .in_("user_id", list(user_ids))
        .eq("status", "open")
        .eq("wallet_source", BOT_WALLET)
    )
    order_q = (
        client.table("terminal_orders")
        .select("user_id,reserved_amount,status,wallet_source,trade_source")
        .in_("user_id", list(user_ids))
        .eq("status", "open")
        .eq("wallet_source", BOT_WALLET)
    )

    wallets, positions, orders = await asyncio.gather(
        _db_call(wallets_q.execute),
        _db_call(pos_q.execute),
        _db_call(order_q.execute),
    )

    equity = {str(uid): 0.0 for uid in user_ids}
    for row in wallets.data or []:
        equity[str(row["user_id"])] = _as_float(row.get("bot_balance"))

    for row in orders.data or []:
        uid = str(row["user_id"])
        equity[uid] = equity.get(uid, 0.0) + _as_float(row.get("reserved_amount"))

    for row in positions.data or []:
        uid = str(row["user_id"])
        entry = _as_float(row.get("entry_price"))
        quantity = _as_float(row.get("quantity"))
        margin = _as_float(row.get("margin"))
        live = _as_float(prices.get(str(row.get("symbol", "")).upper()), entry)
        side = str(row.get("side", "")).upper()
        gross = (entry - live) * quantity if side == "SHORT" else (live - entry) * quantity
        close_fee = live * quantity * 0.0001
        equity[uid] = equity.get(uid, 0.0) + margin + gross - close_fee

    return equity


async def _all_bot_prices(user_ids: set[str]) -> dict[str, float]:
    if not user_ids:
        return {}
    client = get_service_client()
    q = (
        client.table("terminal_positions")
        .select("symbol")
        .in_("user_id", list(user_ids))
        .eq("status", "open")
        .eq("wallet_source", BOT_WALLET)
    )
    rows = (await _db_call(q.execute)).data or []
    symbols = sorted({str(row.get("symbol", "")).upper() for row in rows if row.get("symbol")})
    return await latest_prices(symbols) if symbols else {}


async def begin_daily_sessions(accounts: list[dict]) -> list[dict]:
    if not accounts:
        return []

    user_ids = {str(row["user_id"]) for row in accounts}
    prices = await _all_bot_prices(user_ids)
    equities = await _bot_equities(user_ids, prices)
    today = datetime.now(NY).date().isoformat()
    refreshed: list[dict] = []

    for account in accounts:
        uid = str(account["user_id"])
        base = _as_float(account.get("initial_balance"))
        if base <= 0:
            continue

        # Profit target AMOUNT is always 1% of launch base.
        # Each 08:00 session starts from live equity so day 2 does not instantly
        # stop just because the previous day finished above the original base.
        start_equity = equities.get(uid, base)
        target_amount = base * settings.auto_daily_target_fraction
        target_equity = start_equity + target_amount

        await _rpc(
            "ai_auto_begin_session",
            {
                "p_user_id": uid,
                "p_session_date": today,
                "p_start_equity": start_equity,
                "p_target_equity": target_equity,
                "p_target_amount": target_amount,
            },
        )
        refreshed.append(
            {
                **account,
                "session_date": today,
                "session_start_equity": start_equity,
                "daily_target_equity": target_equity,
                "daily_target_amount": target_amount,
                "trading_locked": False,
            }
        )

    return refreshed


async def run_daily_auto_session() -> dict:
    if _auto_scan_lock.locked():
        return {"running": True, "message": "AUTO scan already running"}

    async with _auto_scan_lock:
        accounts = await _active_accounts()
        accounts = await begin_daily_sessions(accounts)
        if not accounts:
            return {"running": False, "accounts": 0, "signals": 0, "orders_opened": 0}

        symbols = await top_symbols()
        semaphore = asyncio.Semaphore(max(1, settings.scan_concurrency))
        accepted_signals: list[dict] = []

        async def analyze_one(symbol: str):
            async with semaphore:
                try:
                    signal = await analyze_symbol(symbol)
                    if not signal or signal.confidence < settings.auto_minimum_signal_confidence:
                        return
                    saved = save_signal(signal)
                    signal_id = saved.get("database_id")
                    if signal_id:
                        accepted_signals.append(
                            {
                                "id": signal_id,
                                "symbol": signal.symbol,
                                "confidence": signal.confidence,
                            }
                        )
                except Exception as error:  # noqa: BLE001
                    print(f"AUTO {symbol} scan error: {type(error).__name__}: {error}")

        await asyncio.gather(*(analyze_one(symbol) for symbol in symbols))

        opened = 0
        failures = 0
        for account in accounts:
            uid = str(account["user_id"])
            base = _as_float(account.get("initial_balance"))
            risk_usd = base * settings.auto_risk_fraction
            if risk_usd <= 0:
                continue

            for signal in accepted_signals:
                try:
                    result = await _rpc(
                        "ai_auto_open_signal",
                        {
                            "p_user_id": uid,
                            "p_signal_id": signal["id"],
                            "p_risk_usd": risk_usd,
                            "p_leverage": settings.auto_leverage,
                        },
                    )
                    if result:
                        opened += 1
                except Exception as error:  # noqa: BLE001
                    failures += 1
                    print(
                        f"AUTO open skipped user={uid} symbol={signal['symbol']}: "
                        f"{type(error).__name__}: {error}"
                    )

            await _rpc("ai_auto_mark_scan_complete", {"p_user_id": uid})

        return {
            "running": False,
            "accounts": len(accounts),
            "symbols": len(symbols),
            "signals": len(accepted_signals),
            "orders_opened": opened,
            "open_failures": failures,
        }


async def _auto_orders_positions():
    client = get_service_client()
    orders_q = (
        client.table("terminal_orders")
        .select("*")
        .eq("trade_source", AI_SOURCE)
        .eq("ai_mode", AUTO_MODE)
        .eq("status", "open")
    )
    positions_q = (
        client.table("terminal_positions")
        .select("*")
        .eq("trade_source", AI_SOURCE)
        .eq("ai_mode", AUTO_MODE)
        .eq("status", "open")
    )
    orders, positions = await asyncio.gather(
        _db_call(orders_q.execute),
        _db_call(positions_q.execute),
    )
    return orders.data or [], positions.data or []


async def monitor_auto_trading() -> dict:
    if _monitor_lock.locked():
        return {"skipped": True}

    async with _monitor_lock:
        orders, positions = await _auto_orders_positions()
        accounts = await _active_accounts()

        symbols = {
            str(row.get("symbol", "")).upper()
            for row in [*orders, *positions]
            if row.get("symbol")
        }
        prices = await latest_prices(sorted(symbols)) if symbols else {}

        fills = 0
        closes = 0
        for order in orders:
            symbol = str(order.get("symbol", "")).upper()
            live = _as_float(prices.get(symbol))
            limit_price = _as_float(order.get("price"))
            side = str(order.get("side", "")).upper()
            if live <= 0 or limit_price <= 0:
                continue
            triggered = (side == "LONG" and live <= limit_price) or (
                side == "SHORT" and live >= limit_price
            )
            if triggered:
                try:
                    await _rpc(
                        "ai_auto_fill_limit_order",
                        {"p_order_id": str(order["id"]), "p_fill_price": live},
                    )
                    fills += 1
                except Exception as error:  # noqa: BLE001
                    print(f"AUTO limit fill error {order['id']}: {error}")

        # Refresh positions after possible fills.
        if fills:
            _, positions = await _auto_orders_positions()
            symbols.update(
                str(row.get("symbol", "")).upper()
                for row in positions
                if row.get("symbol")
            )
            prices = await latest_prices(sorted(symbols)) if symbols else prices

        for position in positions:
            symbol = str(position.get("symbol", "")).upper()
            live = _as_float(prices.get(symbol))
            if live <= 0:
                continue
            side = str(position.get("side", "")).upper()
            tp = _as_float(position.get("take_profit"))
            sl = _as_float(position.get("stop_loss"))
            liq = _as_float(position.get("liquidation_price"))

            reason = None
            exit_price = live
            if liq > 0 and ((side == "LONG" and live <= liq) or (side == "SHORT" and live >= liq)):
                reason = "LIQUIDATION"
                exit_price = liq
            elif sl > 0 and ((side == "LONG" and live <= sl) or (side == "SHORT" and live >= sl)):
                reason = "STOP_LOSS"
                exit_price = sl
            elif tp > 0 and ((side == "LONG" and live >= tp) or (side == "SHORT" and live <= tp)):
                reason = "TAKE_PROFIT"
                exit_price = tp

            if reason:
                try:
                    await _rpc(
                        "ai_auto_close_position",
                        {
                            "p_position_id": str(position["id"]),
                            "p_exit_price": exit_price,
                            "p_close_reason": reason,
                        },
                    )
                    closes += 1
                except Exception as error:  # noqa: BLE001
                    print(f"AUTO close error {position['id']}: {error}")

        # Daily target: equity includes every BOT-funded AI position/order because
        # that is what the user sees as AI Bot Wallet equity. Only AI_AUTO orders
        # are force-closed/cancelled when the auto session reaches its target.
        if accounts:
            user_ids = {str(row["user_id"]) for row in accounts}
            equity_symbols = await _all_bot_prices(user_ids)
            equities = await _bot_equities(user_ids, equity_symbols)
            today = datetime.now(NY).date().isoformat()

            for account in accounts:
                uid = str(account["user_id"])
                if account.get("trading_locked"):
                    continue
                if str(account.get("session_date") or "") != today:
                    continue
                target = _as_float(account.get("daily_target_equity"))
                current = equities.get(uid, 0.0)
                if target > 0 and current >= target:
                    await close_all_auto_for_user(uid)
                    await _rpc(
                        "ai_auto_lock_target",
                        {"p_user_id": uid, "p_equity": current},
                    )

        return {"fills": fills, "closes": closes, "accounts": len(accounts)}


async def close_all_auto_for_user(user_id: str) -> None:
    client = get_service_client()
    positions_q = (
        client.table("terminal_positions")
        .select("id,symbol")
        .eq("user_id", user_id)
        .eq("trade_source", AI_SOURCE)
        .eq("ai_mode", AUTO_MODE)
        .eq("status", "open")
    )
    orders_q = (
        client.table("terminal_orders")
        .select("id")
        .eq("user_id", user_id)
        .eq("trade_source", AI_SOURCE)
        .eq("ai_mode", AUTO_MODE)
        .eq("status", "open")
    )
    positions, orders = await asyncio.gather(
        _db_call(positions_q.execute),
        _db_call(orders_q.execute),
    )
    positions = positions.data or []
    orders = orders.data or []

    symbols = sorted({str(row.get("symbol", "")).upper() for row in positions if row.get("symbol")})
    prices = await latest_prices(symbols) if symbols else {}

    for row in orders:
        try:
            await _rpc("ai_auto_cancel_order", {"p_order_id": str(row["id"])})
        except Exception as error:  # noqa: BLE001
            print(f"AUTO target cancel error {row['id']}: {error}")

    for row in positions:
        symbol = str(row.get("symbol", "")).upper()
        live = _as_float(prices.get(symbol))
        if live <= 0:
            continue
        try:
            await _rpc(
                "ai_auto_close_position",
                {
                    "p_position_id": str(row["id"]),
                    "p_exit_price": live,
                    "p_close_reason": "DAILY_TARGET",
                },
            )
        except Exception as error:  # noqa: BLE001
            print(f"AUTO target close error {row['id']}: {error}")


async def startup_catchup() -> None:
    now = datetime.now(NY)
    if now.hour < 8:
        return
    accounts = await _active_accounts()
    today = now.date().isoformat()
    if any(str(row.get("session_date") or "") != today for row in accounts):
        await run_daily_auto_session()
