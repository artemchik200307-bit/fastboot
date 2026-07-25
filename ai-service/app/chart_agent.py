from __future__ import annotations

import base64
from html import escape


def _safe_float(value: object, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def build_chart(
    symbol: str,
    candles: list[dict],
    technical: dict,
    entry: float,
    stop: float,
    take: float,
) -> dict:
    """Create a dependency-free SVG candlestick chart.

    Matplotlib was removed because its renderer can hit a recursive deepcopy
    failure on the Python 3.14 runtime used by Render. SVG generation is fully
    deterministic, lightweight and safe for concurrent API requests.
    """
    rows = candles[-80:]
    if not rows:
        raise ValueError("Недостаточно свечей для построения графика")

    width, height = 1280, 640
    left, right, top, bottom = 72, 28, 54, 58
    plot_w = width - left - right
    plot_h = height - top - bottom

    prices: list[float] = []
    for row in rows:
        prices.extend([
            _safe_float(row.get("high")),
            _safe_float(row.get("low")),
        ])
    prices.extend([float(entry), float(stop), float(take)])

    for zone in technical.get("fvg_zones", []):
        prices.extend([_safe_float(zone.get("low")), _safe_float(zone.get("high"))])
    ob = technical.get("order_block")
    if isinstance(ob, dict):
        prices.extend([_safe_float(ob.get("low")), _safe_float(ob.get("high"))])

    p_min, p_max = min(prices), max(prices)
    if p_max <= p_min:
        p_max = p_min + max(abs(p_min) * 0.01, 1.0)
    margin = (p_max - p_min) * 0.06
    p_min -= margin
    p_max += margin

    def y(price: float) -> float:
        return top + (p_max - price) / (p_max - p_min) * plot_h

    step = plot_w / max(len(rows), 1)
    candle_w = max(2.5, min(10.0, step * 0.58))
    offset = max(0, len(candles) - len(rows))

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#0f172a"/>',
        f'<text x="{left}" y="31" fill="#f8fafc" font-size="22" font-family="Arial, sans-serif" font-weight="700">{escape(symbol)} — техническая разметка</text>',
    ]

    # Grid and price labels.
    for i in range(6):
        price = p_min + (p_max - p_min) * i / 5
        yy = y(price)
        parts.append(f'<line x1="{left}" y1="{yy:.2f}" x2="{width-right}" y2="{yy:.2f}" stroke="#334155" stroke-width="1" opacity="0.55"/>')
        parts.append(f'<text x="8" y="{yy+4:.2f}" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">{price:.6g}</text>')

    # FVG zones.
    for zone in technical.get("fvg_zones", []):
        idx = int(zone.get("index", 0)) - offset
        if idx < 0 or idx >= len(rows):
            continue
        low = _safe_float(zone.get("low"))
        high = _safe_float(zone.get("high"))
        yy = min(y(low), y(high))
        hh = max(2.0, abs(y(low) - y(high)))
        xx = left + idx * step
        zone_color = "#22c55e" if "bullish" in str(zone.get("type", "")) else "#ef4444"
        parts.append(f'<rect x="{xx:.2f}" y="{yy:.2f}" width="{width-right-xx:.2f}" height="{hh:.2f}" fill="{zone_color}" opacity="0.12"/>')

    # Order block zone.
    if isinstance(ob, dict):
        low = _safe_float(ob.get("low"))
        high = _safe_float(ob.get("high"))
        yy = min(y(low), y(high))
        hh = max(2.0, abs(y(low) - y(high)))
        parts.append(f'<rect x="{left}" y="{yy:.2f}" width="{plot_w}" height="{hh:.2f}" fill="#a855f7" opacity="0.11"/>')

    # Candles.
    for i, row in enumerate(rows):
        o = _safe_float(row.get("open"))
        h = _safe_float(row.get("high"))
        l = _safe_float(row.get("low"))
        c = _safe_float(row.get("close"))
        xx = left + (i + 0.5) * step
        color = "#22c55e" if c >= o else "#ef4444"
        parts.append(f'<line x1="{xx:.2f}" y1="{y(h):.2f}" x2="{xx:.2f}" y2="{y(l):.2f}" stroke="{color}" stroke-width="1.25"/>')
        body_y = min(y(o), y(c))
        body_h = max(1.5, abs(y(o) - y(c)))
        parts.append(f'<rect x="{xx-candle_w/2:.2f}" y="{body_y:.2f}" width="{candle_w:.2f}" height="{body_h:.2f}" fill="{color}" rx="0.8"/>')

    def level_line(price: float, label: str, color: str, dashed: bool = False) -> None:
        yy = y(price)
        dash = ' stroke-dasharray="8 6"' if dashed else ""
        parts.append(f'<line x1="{left}" y1="{yy:.2f}" x2="{width-right}" y2="{yy:.2f}" stroke="{color}" stroke-width="1.7"{dash}/>')
        label_w = 118
        parts.append(f'<rect x="{width-right-label_w}" y="{yy-13:.2f}" width="{label_w}" height="22" rx="4" fill="{color}" opacity="0.9"/>')
        parts.append(f'<text x="{width-right-label_w+7}" y="{yy+3:.2f}" fill="#ffffff" font-size="12" font-family="Arial, sans-serif">{escape(label)} {price:.6g}</text>')

    level_line(float(entry), "ENTRY", "#3b82f6")
    level_line(float(stop), "STOP", "#ef4444", True)
    level_line(float(take), "TAKE", "#22c55e", True)

    for price in technical.get("liquidity_highs", [])[-2:]:
        yy = y(_safe_float(price))
        parts.append(f'<line x1="{left}" y1="{yy:.2f}" x2="{width-right}" y2="{yy:.2f}" stroke="#f59e0b" stroke-width="1" stroke-dasharray="3 5" opacity="0.8"/>')
    for price in technical.get("liquidity_lows", [])[-2:]:
        yy = y(_safe_float(price))
        parts.append(f'<line x1="{left}" y1="{yy:.2f}" x2="{width-right}" y2="{yy:.2f}" stroke="#f59e0b" stroke-width="1" stroke-dasharray="3 5" opacity="0.8"/>')

    parts.append(f'<text x="{left}" y="{height-18}" fill="#94a3b8" font-size="13" font-family="Arial, sans-serif">Последние {len(rows)} свечей</text>')
    parts.append('</svg>')

    svg = "".join(parts)
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return {
        "mime_type": "image/svg+xml",
        "image_base64": encoded,
        "data_url": f"data:image/svg+xml;base64,{encoded}",
        "levels": [
            {"label": "Entry", "price": float(entry)},
            {"label": "Stop Loss", "price": float(stop)},
            {"label": "Take Profit", "price": float(take)},
        ],
    }
