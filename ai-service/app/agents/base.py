from abc import ABC, abstractmethod

from app.models import AgentOpinion, MarketSnapshot


class BaseAgent(ABC):
    name: str

    @abstractmethod
    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        raise NotImplementedError
