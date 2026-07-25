from __future__ import annotations

from statistics import mean

from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot


def _ema(values: list[float], period: int) -> float:
    alpha = 2 / (period + 1)
    value = values[0]
    for item in values[1:]:
        value = alpha * item + (1 - alpha) * value
    return value


def _atr(candles: list[dict], period: int = 14) -> float:
    trs: list[float] = []
    for previous, current in zip(candles[:-1], candles[1:]):
        high = float(current["high"])
        low = float(current["low"])
        prev_close = float(previous["close"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return mean(trs[-period:]) if trs else 0.0


def _fractals(candles: list[dict]) -> tuple[list[float], list[float]]:
    highs: list[float] = []
    lows: list[float] = []
    for i in range(2, len(candles) - 2):
        high = float(candles[i]["high"])
        low = float(candles[i]["low"])
        if high == max(float(candles[j]["high"]) for j in range(i - 2, i + 3)):
            highs.append(high)
        if low == min(float(candles[j]["low"]) for j in range(i - 2, i + 3)):
            lows.append(low)
    return highs, lows


def _fvg(candles: list[dict]) -> list[dict]:
    zones: list[dict] = []
    for i in range(2, len(candles)):
        first = candles[i - 2]
        third = candles[i]
        first_high = float(first["high"])
        first_low = float(first["low"])
        third_high = float(third["high"])
        third_low = float(third["low"])
        if third_low > first_high:
            zones.append({"type": "bullish_fvg", "low": first_high, "high": third_low, "index": i})
        elif third_high < first_low:
            zones.append({"type": "bearish_fvg", "low": third_high, "high": first_low, "index": i})
    return zones[-6:]


class MarketAnalysisAgent(BaseAgent):
    name = "ai_market_analysis"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        candles = snapshot.candles
        closes = [float(row["close"]) for row in candles]
        ema20 = _ema(closes[-80:], 20)
        ema50 = _ema(closes[-120:], 50)
        atr = _atr(candles)
        highs, lows = _fractals(candles)
        recent_high = max(float(row["high"]) for row in candles[-40:])
        recent_low = min(float(row["low"]) for row in candles[-40:])
        midpoint = (recent_high + recent_low) / 2

        bullish_structure = len(highs) >= 2 and len(lows) >= 2 and highs[-1] > highs[-2] and lows[-1] > lows[-2]
        bearish_structure = len(highs) >= 2 and len(lows) >= 2 and highs[-1] < highs[-2] and lows[-1] < lows[-2]

        if ema20 > ema50 and (bullish_structure or snapshot.price >= midpoint):
            direction = "LONG"
        elif ema20 < ema50 and (bearish_structure or snapshot.price < midpoint):
            direction = "SHORT"
        else:
            direction = "NEUTRAL"

        distance = abs(ema20 - ema50) / max(snapshot.price, 1e-9) * 100
        structure_bonus = 10 if bullish_structure or bearish_structure else 0
        confidence = min(90, 52 + distance * 35 + structure_bonus)

        bos = None
        if highs and snapshot.price > highs[-1]:
            bos = "bullish_bos"
        elif lows and snapshot.price < lows[-1]:
            bos = "bearish_bos"

        order_block = None
        for row in reversed(candles[-30:-1]):
            o, c = float(row["open"]), float(row["close"])
            if direction == "LONG" and c < o:
                order_block = {"type": "bullish_ob", "low": float(row["low"]), "high": float(row["high"])}
                break
            if direction == "SHORT" and c > o:
                order_block = {"type": "bearish_ob", "low": float(row["low"]), "high": float(row["high"])}
                break

        data = {
            "ema20": ema20,
            "ema50": ema50,
            "atr14": atr,
            "trend": "bullish" if ema20 > ema50 else "bearish",
            "structure": "bullish" if bullish_structure else "bearish" if bearish_structure else "range",
            "bos": bos,
            "range_high": recent_high,
            "range_low": recent_low,
            "midpoint": midpoint,
            "liquidity_highs": highs[-3:],
            "liquidity_lows": lows[-3:],
            "fvg_zones": _fvg(candles),
            "order_block": order_block,
        }

        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=confidence,
            summary=(
                f"Тренд: {data['trend']}; структура: {data['structure']}; "
                f"BOS: {bos or 'не подтверждён'}; цена относительно середины диапазона: "
                f"{'выше' if snapshot.price >= midpoint else 'ниже'}."
            ),
            data=data,
        )
