from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


Direction = Literal["LONG", "SHORT", "NEUTRAL"]


class MarketSnapshot(BaseModel):
    symbol: str
    price: float
    change_percent: float
    quote_volume: float
    high: float
    low: float
    candles: list[dict[str, float | int]] = Field(default_factory=list)


class AgentOpinion(BaseModel):
    agent: str
    direction: Direction
    confidence: float = Field(ge=0, le=100)
    summary: str
    data: dict[str, Any] = Field(default_factory=dict)


class TradingSignal(BaseModel):
    symbol: str
    side: Literal["LONG", "SHORT"]
    order_type: Literal["MARKET", "LIMIT"] = "MARKET"
    entry_price: float
    stop_loss: float
    take_profit: float
    confidence: float
    summary: str
    agent_analysis: dict[str, dict[str, Any]]
    chart_analysis: dict[str, Any]
    valid_until: datetime
