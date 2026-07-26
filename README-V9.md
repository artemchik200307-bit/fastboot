# FASTBOOT V9 — liquidation monitor + full AI coin universe

## Changes
- Liquidation / TP / SL monitoring is now independent from chart refresh and runs every 1 second.
- A temporary chart/depth/klines API failure no longer disables position protection.
- Concurrent protection checks are locked to avoid duplicate closes.
- Terminal coin list now uses Binance `exchangeInfo` + 24h tickers.
- The terminal universe follows the same rules as the AI scanner:
  active `TRADING` spot USDT pairs, excluding stable/fiat bases and leveraged-token suffixes.
- The 100-symbol cap was removed from both loading and dropdown rendering.

## Deployment
No SQL migration is required for these two changes.
Replace/deploy the frontend project files. The important changed file is `terminal.js`.
