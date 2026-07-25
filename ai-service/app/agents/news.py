from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot


class NewsAnalysisAgent(BaseAgent):
    name = "ai_news_analysis"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        # Без новостного ключа агент использует изменение цены как прокси реакции.
        direction = (
            "LONG" if snapshot.change_percent > 1
            else "SHORT" if snapshot.change_percent < -1
            else "NEUTRAL"
        )

        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=min(70, 45 + abs(snapshot.change_percent) * 3),
            summary=(
                "Оценка текущей рыночной реакции. Для полного новостного анализа "
                "подключите новостной источник и макрокалендарь."
            ),
            data={"market_reaction_24h": snapshot.change_percent},
        )
