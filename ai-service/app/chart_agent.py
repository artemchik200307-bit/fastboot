from __future__ import annotations

import base64
from io import BytesIO

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle


def build_chart(symbol: str, candles: list[dict], technical: dict, entry: float, stop: float, take: float) -> dict:
    rows = candles[-80:]
    fig, ax = plt.subplots(figsize=(13, 6.5), dpi=140)

    width = 0.62
    for i, row in enumerate(rows):
        o, h, l, c = (float(row[k]) for k in ("open", "high", "low", "close"))
        up = c >= o
        color = "#16c784" if up else "#ea3943"
        ax.vlines(i, l, h, color=color, linewidth=1)
        body_low = min(o, c)
        body_height = max(abs(c - o), max(entry * 0.00005, 1e-9))
        ax.add_patch(Rectangle((i - width / 2, body_low), width, body_height, facecolor=color, edgecolor=color))

    offset = max(0, len(candles) - len(rows))
    for zone in technical.get("fvg_zones", []):
        idx = int(zone.get("index", 0)) - offset
        if idx >= 0:
            ax.axhspan(float(zone["low"]), float(zone["high"]), alpha=0.12)

    ob = technical.get("order_block")
    if ob:
        ax.axhspan(float(ob["low"]), float(ob["high"]), alpha=0.10)

    for price, label, style in ((entry, "ENTRY", "-"), (stop, "STOP", "--"), (take, "TAKE PROFIT", "--")):
        ax.axhline(price, linestyle=style, linewidth=1.2, label=f"{label}: {price:.6g}")

    for price in technical.get("liquidity_highs", [])[-2:]:
        ax.axhline(float(price), linestyle=":", linewidth=0.8, alpha=0.65)
    for price in technical.get("liquidity_lows", [])[-2:]:
        ax.axhline(float(price), linestyle=":", linewidth=0.8, alpha=0.65)

    ax.set_title(f"{symbol} — техническая разметка")
    ax.set_xlabel("Последние свечи")
    ax.set_ylabel("Цена")
    ax.grid(alpha=0.16)
    ax.legend(loc="best")
    fig.tight_layout()

    buffer = BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight")
    plt.close(fig)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {
        "mime_type": "image/png",
        "image_base64": encoded,
        "data_url": f"data:image/png;base64,{encoded}",
        "levels": [
            {"label": "Entry", "price": entry},
            {"label": "Stop Loss", "price": stop},
            {"label": "Take Profit", "price": take},
        ],
    }
