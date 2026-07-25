from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot


class RiskManagementAgent(BaseAgent):
    name = "ai_risk_management"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        volatility = (
            (snapshot.high - snapshot.low) / max(snapshot.price, 1) * 100
        )

        direction = "NEUTRAL"
        confidence = max(40, 75 - volatility * 3)

        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=confidence,
            summary=(
                f"Внутридневной диапазон составляет {volatility:.2f}%. "
                "Размер позиции должен рассчитываться только через Stop Loss."
            ),
            data={"range_percent": volatility},
        )
