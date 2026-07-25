from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot


class TradingAssistantAgent(BaseAgent):
    name = "ai_trading_assistant"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        direction = "LONG" if snapshot.change_percent >= 0 else "SHORT"

        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=58,
            summary=(
                "Формируется основной и альтернативный сценарий. "
                "Финальный вход публикуется только после согласования агентов."
            ),
            data={},
        )
