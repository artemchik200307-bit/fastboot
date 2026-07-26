# FASTBOOT V8 — AI trades inside Terminal

## What changed

- Manual AI signals now create real Terminal positions/orders.
- AI-created terminal rows are marked `AI`; normal terminal trades are marked `MANUAL`.
- AI trades use only `wallets.bot_balance`.
- Normal terminal trades continue to use only `wallets.trading_balance`.
- Market orders, limit orders, cancel, close, TP/SL and liquidation are source-aware.
- Limit orders are checked for all open symbols, not only the chart currently selected in Terminal.
- Manual AI Assistant page keeps closed trade history and no longer shows a duplicate open-positions block.
- AI Bot Wallet is displayed as live equity: free AI cash + reserved AI limit orders + open-position equity.
- AI equity refreshes every 5 seconds while the page is visible.
- Admin manual-AI statistics now read from the shared terminal records.

## Deploy

1. Upload the project files to GitHub/Render.
2. In Supabase SQL Editor run **`supabase-fastboot-v8-ai-terminal-integration.sql`** after the previous terminal/V6/V7 migrations.
3. Reload the site.

Important: run V8 last. Older SQL files contain earlier versions of terminal RPC functions and should not be re-run after V8.

## Quick check

1. Put funds into AI Bot Wallet and separately into Terminal wallet.
2. Open a MARKET AI signal: it should appear in Terminal with `AI` badge, while Terminal wallet balance stays unchanged.
3. Create/open a LIMIT AI signal: it should appear under open orders with `AI` badge and fill when price reaches the limit.
4. Edit TP/SL in Terminal on the AI position.
5. Close the AI position: funds/PnL return to AI Bot Wallet, not Terminal wallet.
6. Open a normal Terminal trade: it should show `MANUAL` and affect only Terminal wallet.
