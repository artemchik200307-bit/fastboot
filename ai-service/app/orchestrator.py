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
from app.chart_agent import build_chart
from app.llm_committee import committee_summary
from app.market_data import snapshot
from app.models import TradingSignal

AGENTS = (
    MarketAnalysisAgent(), NewsAnalysisAgent(), SmartMoneyAgent(),
    RiskManagementAgent(), TradingAssistantAgent(), InstitutionalAgent(),
)


async def analyze_symbol(symbol: str) -> TradingSignal | None:
    market = await snapshot(symbol)
    opinions = await asyncio.gather(*(agent.analyze(market) for agent in AGENTS))
    directional = [op for op in opinions if op.direction in ("LONG", "SHORT")]
    long_score = sum(op.confidence for op in directional if op.direction == "LONG")
    short_score = sum(op.confidence for op in directional if op.direction == "SHORT")
    side = "LONG" if long_score >= short_score else "SHORT"
    supporters = [op.confidence for op in directional if op.direction == side]
    if len(supporters) < 3:
        return None

    confidence = mean(supporters)
    technical_opinion = next(op for op in opinions if op.agent == "ai_market_analysis")
    technical = technical_opinion.data
    entry = market.price
    atr = float(technical.get("atr14") or entry * 0.004)
    if side == "LONG":
        structural = min(float(row["low"]) for row in market.candles[-24:])
        stop = min(entry - max(atr * 1.2, entry * 0.004), structural)
        risk_distance = entry - stop
        take = entry + risk_distance * 2
    else:
        structural = max(float(row["high"]) for row in market.candles[-24:])
        stop = max(entry + max(atr * 1.2, entry * 0.004), structural)
        risk_distance = stop - entry
        take = entry - risk_distance * 2

    analysis = {op.agent: op.model_dump() for op in opinions}
    summary = await committee_summary(symbol, side, confidence, analysis)
    chart = build_chart(symbol, market.candles, technical, entry, stop, take)
    chart.update({"candles": market.candles[-80:], "technical_markup": technical})

    return TradingSignal(
        symbol=symbol, side=side, order_type="MARKET", entry_price=entry,
        stop_loss=stop, take_profit=take, confidence=confidence,
        summary=summary, agent_analysis=analysis, chart_analysis=chart,
        valid_until=datetime.now(UTC) + timedelta(minutes=15),
    )
