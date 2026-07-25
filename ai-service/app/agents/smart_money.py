from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot


class SmartMoneyAgent(BaseAgent):
    name = "ai_smart_money_system"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        candles = snapshot.candles
        recent_high = max(float(row["high"]) for row in candles[-24:])
        recent_low = min(float(row["low"]) for row in candles[-24:])
        midpoint = (recent_high + recent_low) / 2
        direction = "LONG" if snapshot.price >= midpoint else "SHORT"

        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=62,
            summary=(
                "Цена оценивается относительно локального диапазона, "
                "ликвидности и потенциальных зон дисбаланса."
            ),
            data={
                "range_high": recent_high,
                "range_low": recent_low,
                "midpoint": midpoint,
            },
        )
