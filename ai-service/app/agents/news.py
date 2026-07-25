from __future__ import annotations

import asyncio
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime

import httpx

from app.agents.base import BaseAgent
from app.models import AgentOpinion, MarketSnapshot

RSS_FEEDS = (
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
    "https://cryptoslate.com/feed/",
)
POSITIVE = {"surge", "gain", "approve", "approval", "adoption", "bullish", "record", "rally", "partnership", "launch"}
NEGATIVE = {"hack", "exploit", "ban", "lawsuit", "bearish", "drop", "crash", "outflow", "liquidation", "fraud"}


def _coin_terms(symbol: str) -> set[str]:
    base = symbol.replace("USDT", "").lower()
    aliases = {
        "btc": {"bitcoin", "btc"},
        "eth": {"ethereum", "ether", "eth"},
        "sol": {"solana", "sol"},
        "bnb": {"bnb", "binance coin"},
        "xrp": {"xrp", "ripple"},
        "ada": {"cardano", "ada"},
        "doge": {"dogecoin", "doge"},
    }
    return aliases.get(base, {base}) | {"crypto", "cryptocurrency", "market"}


async def _fetch_feed(client: httpx.AsyncClient, url: str) -> list[dict]:
    try:
        response = await client.get(url, follow_redirects=True)
        response.raise_for_status()
        root = ET.fromstring(response.text)
        items: list[dict] = []
        for item in root.findall(".//item")[:20]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            published = (item.findtext("pubDate") or "").strip()
            if title:
                items.append({"title": title, "url": link, "published": published, "source": url})
        return items
    except Exception:
        return []


class NewsAnalysisAgent(BaseAgent):
    name = "ai_news_analysis"

    async def analyze(self, snapshot: MarketSnapshot) -> AgentOpinion:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "FASTBOOT-AI/1.0"}) as client:
            results = await asyncio.gather(*(_fetch_feed(client, url) for url in RSS_FEEDS))

        terms = _coin_terms(snapshot.symbol)
        all_items = [item for group in results for item in group]
        relevant = [item for item in all_items if any(term in item["title"].lower() for term in terms)][:10]

        score = 0
        for item in relevant:
            words = set(re.findall(r"[a-z]+", item["title"].lower()))
            score += len(words & POSITIVE)
            score -= len(words & NEGATIVE)

        if score > 0:
            direction = "LONG"
        elif score < 0:
            direction = "SHORT"
        else:
            direction = "NEUTRAL"

        confidence = min(78, 45 + abs(score) * 8 + min(len(relevant), 5) * 2)
        return AgentOpinion(
            agent=self.name,
            direction=direction,
            confidence=confidence,
            summary=(
                f"Проверено {len(all_items)} RSS-заголовков, релевантных активу: {len(relevant)}. "
                f"Новостной уклон: {direction.lower()}."
            ),
            data={"score": score, "headlines": relevant, "checked_at": datetime.now(UTC).isoformat()},
        )
