from statistics import mean

from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot


class InstitutionalAgent(BaseAgent):
    name = "institutional_analysis"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        volumes = [float(row["volume"]) for row in snapshot.candles]
        current = mean(volumes[-5:])
        baseline = mean(volumes[-40:-5]) if len(volumes) >= 45 else mean(volumes)
        anomaly = current / max(baseline, 1e-9)

        direction = "LONG" if snapshot.change_percent >= 0 else "SHORT"

        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=min(80, 50 + max(anomaly - 1, 0) * 20),
            summary=(
                "Оцениваются аномальный объём, ускорение цены и возможное "
                "участие крупных игроков."
            ),
            data={"volume_anomaly_ratio": anomaly},
        )
