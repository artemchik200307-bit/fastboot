from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from statistics import mean

from app.agents.institutional import InstitutionalAgent
from app.agents.news import NewsAnalysisAgent
from app.agents.risk import RiskManagementAgent
from app.agents.smart_money import SmartMoneyAgent
from app.agents.technical import MarketAnalysisAgent
from app.agents.trading import TradingAssistantAgent
from app.market_data import snapshot
from app.models import TradingSignal


AGENTS = (
    MarketAnalysisAgent(),
    NewsAnalysisAgent(),
    SmartMoneyAgent(),
    RiskManagementAgent(),
    TradingAssistantAgent(),
    InstitutionalAgent(),
)


async def analyze_symbol(symbol: str) -> TradingSignal | None:
    market = await snapshot(symbol)
    opinions = await asyncio.gather(
        *(agent.analyze(market) for agent in AGENTS)
    )

    directional = [
        opinion for opinion in opinions
        if opinion.direction in ("LONG", "SHORT")
    ]

    long_score = sum(
        opinion.confidence
        for opinion in directional
        if opinion.direction == "LONG"
    )
    short_score = sum(
        opinion.confidence
        for opinion in directional
        if opinion.direction == "SHORT"
    )

    side = "LONG" if long_score >= short_score else "SHORT"
    supporters = [
        opinion.confidence
        for opinion in directional
        if opinion.direction == side
    ]

    if len(supporters) < 3:
        return None

    confidence = mean(supporters)
    candles = market.candles
    recent_lows = [float(row["low"]) for row in candles[-24:]]
    recent_highs = [float(row["high"]) for row in candles[-24:]]

    entry = market.price

    if side == "LONG":
        stop = min(recent_lows)
        risk_distance = max(entry - stop, entry * 0.004)
        stop = entry - risk_distance
        take = entry + risk_distance * 2
    else:
        stop = max(recent_highs)
        risk_distance = max(stop - entry, entry * 0.004)
        stop = entry + risk_distance
        take = entry - risk_distance * 2

    analysis = {
        opinion.agent: opinion.model_dump()
        for opinion in opinions
    }

    return TradingSignal(
        symbol=symbol,
        side=side,
        order_type="MARKET",
        entry_price=entry,
        stop_loss=stop,
        take_profit=take,
        confidence=confidence,
        summary=(
            f"{symbol} {side}: согласованный сценарий шести агентов. "
            "Перед входом проверьте риск, актуальную цену и срок сигнала."
        ),
        agent_analysis=analysis,
        chart_analysis={
            "candles": candles[-80:],
            "levels": [
                {"label": "Entry", "price": entry},
                {"label": "Stop Loss", "price": stop},
                {"label": "Take Profit", "price": take},
            ],
        },
        valid_until=datetime.now(UTC) + timedelta(minutes=15),
    )
