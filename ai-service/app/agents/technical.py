from statistics import mean

from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot


class MarketAnalysisAgent(BaseAgent):
    name = "ai_market_analysis"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        closes = [float(row["close"]) for row in snapshot.candles]
        fast = mean(closes[-20:])
        slow = mean(closes[-50:])
        direction = "LONG" if fast > slow else "SHORT"
        distance = abs(fast - slow) / max(snapshot.price, 1) * 100
        confidence = min(85, 55 + distance * 30)

        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=confidence,
            summary=(
                f"Средняя за 20 свечей {'выше' if direction == 'LONG' else 'ниже'} "
                "средней за 50 свечей. Анализируются тренд, объём и волатильность."
            ),
            data={"fast_ma": fast, "slow_ma": slow},
        )
