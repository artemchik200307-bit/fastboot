# FASTBOOT V12 — Automatic AI mode

Implemented behavior:

- Enabling AI captures `initial_balance` from AI Bot Wallet. It stays fixed until the user stops and starts the bot again.
- Daily AUTO session starts at **08:00 America/New_York** (DST-aware).
- All supported active USDT coins are analyzed.
- Only signals with confidence >= **60%** are eligible.
- Risk per AUTO signal = **0.1% of fixed launch balance**.
- AUTO leverage is fixed at **x3**.
- AUTO trades use only **AI Bot Wallet**.
- Positions/orders appear in the normal terminal and are tagged **AI AUTO**.
- User-opened AI signals are tagged **AI MANUAL**.
- Both AI MANUAL and AI AUTO closed trades appear in the AI Assistant history.
- The daily profit target amount is **1% of fixed launch balance**.
- At 08:00 the service stores the session's live AI equity, and target equity = session start equity + fixed daily target amount.
  Example: launch base = 100 USDT -> risk = 0.10 USDT/trade and daily target amount = 1.00 USDT every day,
  whether today's starting equity is 99.50, 100.00 or 101.00.
- When target equity is reached: close all **AI AUTO** positions, cancel all **AI AUTO** limit orders, lock new AUTO entries until next 08:00.
- AI MANUAL and normal MANUAL trades are not force-closed by AUTO daily target.
- Server monitor handles AUTO limit fills, TP, SL and liquidation even if the terminal page is not open, as long as the AI service itself is running.

## Required deployment order

1. In Supabase SQL Editor run `supabase-fastboot-v12-auto-mode.sql` once, after V11.
2. Deploy the full V12 project.
3. Redeploy `ai-service` on Render with existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Check `/health` returns version `12.0.0`.
5. For testing without waiting until 08:00, POST `/api/v1/auto/run`.
6. POST `/api/v1/auto/monitor` can manually run one protection/target cycle.

## Important hosting note

The scheduler runs inside the AI service process. If a free hosting plan suspends the service while idle, no in-process scheduler can execute during suspension. For production-grade exact 08:00 execution, keep the service always-on or use a platform cron/scheduled job that calls `/api/v1/auto/run`.
