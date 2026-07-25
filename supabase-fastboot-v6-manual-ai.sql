-- FASTBOOT V6.0 MANUAL AI
-- Выполнить после существующих SQL-миграций проекта.

create extension if not exists pgcrypto;

create table if not exists public.ai_assistant_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active_mode text not null default 'AUTO'
    check (active_mode in ('AUTO','MANUAL')),
  status text not null default 'PAUSED'
    check (status in ('ACTIVE','PAUSED')),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_manual_signals (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  order_type text not null default 'MARKET'
    check (order_type in ('MARKET','LIMIT')),
  entry_price numeric not null check (entry_price > 0),
  stop_loss numeric not null check (stop_loss > 0),
  take_profit numeric not null check (take_profit > 0),
  confidence numeric not null default 0
    check (confidence between 0 and 100),
  summary text not null default '',
  agent_analysis jsonb not null default '{}'::jsonb,
  chart_analysis jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','EXECUTED','EXPIRED','CANCELLED')),
  valid_until timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_manual_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id uuid not null references public.ai_manual_signals(id),
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  order_type text not null,
  entry_price numeric not null,
  stop_loss numeric not null,
  take_profit numeric not null,
  quantity numeric not null,
  notional numeric not null,
  margin numeric not null,
  leverage integer not null,
  liquidation_price numeric not null,
  risk_usd numeric not null,
  opening_fee numeric not null default 0,
  status text not null default 'OPEN'
    check (status in ('OPEN','CLOSED','CANCELLED')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  exit_price numeric,
  gross_pnl numeric,
  platform_fee numeric,
  net_pnl numeric,
  close_reason text
);

create unique index if not exists ai_manual_signal_user_once
  on public.ai_manual_positions(user_id, signal_id)
  where status = 'OPEN';

alter table public.ai_assistant_settings enable row level security;
alter table public.ai_manual_signals enable row level security;
alter table public.ai_manual_positions enable row level security;

drop policy if exists ai_settings_own on public.ai_assistant_settings;
create policy ai_settings_own
on public.ai_assistant_settings
for select to authenticated
using (user_id = auth.uid());

drop policy if exists ai_signals_authenticated on public.ai_manual_signals;
create policy ai_signals_authenticated
on public.ai_manual_signals
for select to authenticated
using (true);

drop policy if exists ai_manual_positions_own on public.ai_manual_positions;
create policy ai_manual_positions_own
on public.ai_manual_positions
for select to authenticated
using (user_id = auth.uid());

create or replace function public.get_ai_assistant_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.ai_assistant_settings;
begin
  if v_user_id is null then
    raise exception 'Пользователь не авторизован';
  end if;

  insert into public.ai_assistant_settings(user_id)
  values(v_user_id)
  on conflict(user_id) do nothing;

  select *
  into v_row
  from public.ai_assistant_settings
  where user_id = v_user_id;

  return jsonb_build_object(
    'active_mode', v_row.active_mode,
    'status', v_row.status,
    'updated_at', v_row.updated_at
  );
end;
$$;

create or replace function public.set_ai_assistant_mode(
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_mode text := upper(trim(p_mode));
begin
  if v_user_id is null then
    raise exception 'Пользователь не авторизован';
  end if;

  if v_mode not in ('AUTO','MANUAL') then
    raise exception 'Некорректный режим';
  end if;

  insert into public.ai_assistant_settings(
    user_id,active_mode,status
  )
  values(
    v_user_id,v_mode,'ACTIVE'
  )
  on conflict(user_id) do update
  set
    active_mode = excluded.active_mode,
    status = 'ACTIVE',
    updated_at = now();

  -- Автоматическое открытие новых сделок разрешено только в AUTO.
  if to_regclass('public.ai_bot_accounts') is not null then
    update public.ai_bot_accounts
    set is_active = (v_mode = 'AUTO')
    where user_id = v_user_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'active_mode', v_mode
  );
end;
$$;

create or replace function public.fastboot_ai_max_leverage(
  p_symbol text
)
returns integer
language sql
immutable
as $$
  select case
    when upper(p_symbol) in ('BTCUSDT','ETHUSDT') then 100
    else 50
  end;
$$;

create or replace function public.fastboot_ai_maintenance_rate(
  p_symbol text
)
returns numeric
language sql
immutable
as $$
  select case
    when upper(p_symbol) in ('BTCUSDT','ETHUSDT') then 0.005
    else 0.01
  end;
$$;

create or replace function public.execute_ai_manual_signal(
  p_signal_id uuid,
  p_risk_usd numeric,
  p_leverage integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_signal public.ai_manual_signals;
  v_settings public.ai_assistant_settings;
  v_wallet public.wallets;
  v_distance numeric;
  v_quantity numeric;
  v_notional numeric;
  v_margin numeric;
  v_opening_fee numeric;
  v_required numeric;
  v_mmr numeric;
  v_liquidation numeric;
  v_position_id uuid;
  v_max_leverage integer;
begin
  if v_user_id is null then
    raise exception 'Пользователь не авторизован';
  end if;

  if p_risk_usd is null or p_risk_usd <= 0 then
    raise exception 'Риск должен быть больше нуля';
  end if;

  select * into v_settings
  from public.ai_assistant_settings
  where user_id = v_user_id;

  if not found or v_settings.active_mode <> 'MANUAL' then
    raise exception 'Сначала включите ручной AI-режим';
  end if;

  select * into v_signal
  from public.ai_manual_signals
  where id = p_signal_id
    and status = 'ACTIVE'
    and valid_until > now()
  for update;

  if not found then
    raise exception 'Сигнал не найден или больше не активен';
  end if;

  v_max_leverage := public.fastboot_ai_max_leverage(v_signal.symbol);

  if p_leverage < 1 or p_leverage > v_max_leverage then
    raise exception 'Максимальное плечо для % — x%',
      v_signal.symbol, v_max_leverage;
  end if;

  v_distance := abs(v_signal.entry_price - v_signal.stop_loss);

  if v_distance <= 0 then
    raise exception 'Некорректный Stop Loss';
  end if;

  v_quantity := p_risk_usd / v_distance;
  v_notional := v_quantity * v_signal.entry_price;
  v_margin := v_notional / p_leverage;
  v_opening_fee := v_notional * 0.0001;
  v_required := v_margin + v_opening_fee;
  v_mmr := public.fastboot_ai_maintenance_rate(v_signal.symbol);

  if v_signal.side = 'LONG' then
    v_liquidation :=
      (
        v_signal.entry_price * v_quantity - v_margin
      ) /
      (
        v_quantity * (1 - v_mmr - 0.0001)
      );
  else
    v_liquidation :=
      (
        v_signal.entry_price * v_quantity + v_margin
      ) /
      (
        v_quantity * (1 + v_mmr + 0.0001)
      );
  end if;

  select * into v_wallet
  from public.wallets
  where user_id = v_user_id
  for update;

  if not found then
    raise exception 'Кошелёк пользователя не найден';
  end if;

  if coalesce(v_wallet.bot_balance,0) < v_required then
    raise exception 'Недостаточно средств на AI-счёте. Нужно % USDT',
      round(v_required,2);
  end if;

  update public.wallets
  set
    bot_balance = bot_balance - v_required,
    updated_at = now()
  where user_id = v_user_id;

  insert into public.ai_manual_positions(
    user_id,signal_id,symbol,side,order_type,
    entry_price,stop_loss,take_profit,quantity,
    notional,margin,leverage,liquidation_price,
    risk_usd,opening_fee
  )
  values(
    v_user_id,v_signal.id,v_signal.symbol,v_signal.side,
    v_signal.order_type,v_signal.entry_price,v_signal.stop_loss,
    v_signal.take_profit,v_quantity,v_notional,v_margin,p_leverage,
    greatest(v_liquidation,0),p_risk_usd,v_opening_fee
  )
  returning id into v_position_id;

  return jsonb_build_object(
    'success', true,
    'position_id', v_position_id,
    'quantity', v_quantity,
    'notional', v_notional,
    'margin', v_margin,
    'liquidation_price', greatest(v_liquidation,0),
    'opening_fee', v_opening_fee
  );
end;
$$;

grant execute on function public.get_ai_assistant_settings() to authenticated;
grant execute on function public.set_ai_assistant_mode(text) to authenticated;
grant execute on function public.execute_ai_manual_signal(uuid,numeric,integer) to authenticated;

-- Источник сделки для общей статистики.
do $$
begin
  if to_regclass('public.user_ai_trade_results') is not null then
    alter table public.user_ai_trade_results
      add column if not exists trade_source text not null default 'AUTO';
  end if;
end;
$$;
