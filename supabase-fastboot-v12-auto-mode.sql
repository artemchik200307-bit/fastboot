-- FASTBOOT V12 — automatic AI trading mode
-- Run AFTER V11 migrations.
-- Adds AUTO/MANUAL AI tagging, fixed launch base, 08:00 session state
-- and service-role RPCs used by fastboot-ai.

create extension if not exists pgcrypto;

-- 1) Distinguish AI manual and AI automatic trades while preserving trade_source='AI'
alter table public.terminal_positions
  add column if not exists ai_mode text;

alter table public.terminal_orders
  add column if not exists ai_mode text;

alter table public.terminal_trades
  add column if not exists ai_mode text;

update public.terminal_positions
set ai_mode='MANUAL'
where trade_source='AI' and ai_mode is null;

update public.terminal_orders
set ai_mode='MANUAL'
where trade_source='AI' and ai_mode is null;

update public.terminal_trades
set ai_mode='MANUAL'
where trade_source='AI' and ai_mode is null;

alter table public.terminal_positions drop constraint if exists terminal_positions_ai_mode_check;
alter table public.terminal_positions add constraint terminal_positions_ai_mode_check
  check (ai_mode is null or ai_mode in ('MANUAL','AUTO'));

alter table public.terminal_orders drop constraint if exists terminal_orders_ai_mode_check;
alter table public.terminal_orders add constraint terminal_orders_ai_mode_check
  check (ai_mode is null or ai_mode in ('MANUAL','AUTO'));

alter table public.terminal_trades drop constraint if exists terminal_trades_ai_mode_check;
alter table public.terminal_trades add constraint terminal_trades_ai_mode_check
  check (ai_mode is null or ai_mode in ('MANUAL','AUTO'));

create index if not exists terminal_positions_ai_auto_idx
  on public.terminal_positions(user_id,ai_mode,status,opened_at desc);

create index if not exists terminal_orders_ai_auto_idx
  on public.terminal_orders(user_id,ai_mode,status,created_at desc);

create index if not exists terminal_trades_ai_auto_idx
  on public.terminal_trades(user_id,ai_mode,closed_at desc);

-- 2) Persist launch base and daily AUTO session state.
create table if not exists public.ai_bot_accounts(
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_active boolean not null default false,
  started_at timestamptz,
  stopped_at timestamptz,
  initial_balance numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_bot_accounts
  add column if not exists session_date date,
  add column if not exists session_start_equity numeric,
  add column if not exists daily_target_equity numeric,
  add column if not exists daily_target_amount numeric,
  add column if not exists trading_locked boolean not null default false,
  add column if not exists target_reached_at timestamptz,
  add column if not exists target_reached_equity numeric,
  add column if not exists last_scan_at timestamptz,
  add column if not exists timezone text not null default 'America/New_York';

-- Start/stop from the user's AI Assistant.
-- IMPORTANT: launch base is captured ONLY when switching from OFF -> ON.
create or replace function public.set_ai_bot_status(p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallets;
  v_account public.ai_bot_accounts;
  v_base numeric;
begin
  if v_user_id is null then raise exception 'Пользователь не авторизован'; end if;

  select * into v_wallet
  from public.wallets
  where user_id=v_user_id
  for update;
  if not found then raise exception 'AI Bot Wallet не найден'; end if;

  select * into v_account
  from public.ai_bot_accounts
  where user_id=v_user_id
  for update;

  if p_active then
    if coalesce(v_wallet.bot_balance,0)<50 then
      raise exception 'Для запуска AI Assistant нужно минимум 50 USDT';
    end if;

    -- Recalculate base only on a genuine fresh start.
    if not found or not coalesce(v_account.is_active,false) then
      v_base := coalesce(v_wallet.bot_balance,0);

      insert into public.ai_bot_accounts(
        user_id,is_active,started_at,stopped_at,initial_balance,
        session_date,session_start_equity,daily_target_equity,
        daily_target_amount,trading_locked,target_reached_at,target_reached_equity,
        last_scan_at,timezone,updated_at
      ) values(
        v_user_id,true,now(),null,v_base,
        null,null,null,null,false,null,null,null,'America/New_York',now()
      )
      on conflict(user_id) do update set
        is_active=true,
        started_at=now(),
        stopped_at=null,
        initial_balance=excluded.initial_balance,
        session_date=null,
        session_start_equity=null,
        daily_target_equity=null,
        daily_target_amount=null,
        trading_locked=false,
        target_reached_at=null,
        target_reached_equity=null,
        last_scan_at=null,
        timezone='America/New_York',
        updated_at=now();
    end if;
  else
    insert into public.ai_bot_accounts(user_id,is_active,stopped_at,initial_balance,updated_at)
    values(v_user_id,false,now(),coalesce(v_wallet.bot_balance,0),now())
    on conflict(user_id) do update set
      is_active=false,
      stopped_at=now(),
      updated_at=now();
  end if;

  return jsonb_build_object('success',true,'is_active',p_active);
end;
$$;

grant execute on function public.set_ai_bot_status(boolean) to authenticated;

-- 3) Session helpers — service role only.
create or replace function public.ai_auto_begin_session(
  p_user_id uuid,
  p_session_date date,
  p_start_equity numeric,
  p_target_equity numeric,
  p_target_amount numeric
)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  update public.ai_bot_accounts
  set session_date=p_session_date,
      session_start_equity=p_start_equity,
      daily_target_equity=p_target_equity,
      daily_target_amount=p_target_amount,
      trading_locked=false,
      target_reached_at=null,
      target_reached_equity=null,
      last_scan_at=null,
      updated_at=now()
  where user_id=p_user_id and is_active=true;
end;
$$;

create or replace function public.ai_auto_mark_scan_complete(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  update public.ai_bot_accounts
  set last_scan_at=now(),updated_at=now()
  where user_id=p_user_id;
end;
$$;

create or replace function public.ai_auto_lock_target(p_user_id uuid,p_equity numeric)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  update public.ai_bot_accounts
  set trading_locked=true,target_reached_at=now(),target_reached_equity=p_equity,updated_at=now()
  where user_id=p_user_id;
end;
$$;

-- 4) AUTO opening. Uses BOT wallet, confidence >= 60, x3 expected by backend.
create or replace function public.ai_auto_open_signal(
  p_user_id uuid,
  p_signal_id uuid,
  p_risk_usd numeric,
  p_leverage integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_signal public.ai_manual_signals;
  v_wallet public.wallets;
  v_account public.ai_bot_accounts;
  v_distance numeric;
  v_quantity numeric;
  v_notional numeric;
  v_margin numeric;
  v_opening_fee numeric;
  v_required numeric;
  v_mmr numeric;
  v_liquidation numeric;
  v_object_id uuid;
  v_kind text;
begin
  if p_risk_usd is null or p_risk_usd<=0 then raise exception 'Некорректный риск'; end if;
  if p_leverage<>3 then raise exception 'AUTO режим использует только плечо x3'; end if;

  select * into v_account
  from public.ai_bot_accounts
  where user_id=p_user_id
  for update;

  if not found or not v_account.is_active then raise exception 'AI-бот выключен'; end if;
  if v_account.trading_locked then raise exception 'Дневная торговля уже остановлена'; end if;

  select * into v_signal
  from public.ai_manual_signals
  where id=p_signal_id and status='ACTIVE' and valid_until>now()
  for update;

  if not found then raise exception 'Сигнал неактивен'; end if;
  if coalesce(v_signal.confidence,0)<60 then raise exception 'Confidence ниже 60%%'; end if;

  -- One AUTO exposure per symbol at a time.
  if exists(
    select 1 from public.terminal_positions
    where user_id=p_user_id and symbol=upper(v_signal.symbol)
      and trade_source='AI' and ai_mode='AUTO' and status='open'
  ) or exists(
    select 1 from public.terminal_orders
    where user_id=p_user_id and symbol=upper(v_signal.symbol)
      and trade_source='AI' and ai_mode='AUTO' and status='open'
  ) then
    raise exception 'AUTO позиция/ордер по этой паре уже существует';
  end if;

  v_distance := abs(v_signal.entry_price-v_signal.stop_loss);
  if v_distance<=0 then raise exception 'Некорректный Stop Loss'; end if;

  v_quantity := p_risk_usd/v_distance;
  v_notional := v_quantity*v_signal.entry_price;
  v_margin := v_notional/p_leverage;
  v_opening_fee := v_notional*0.0001;
  v_required := v_margin+v_opening_fee;
  v_mmr := public.fastboot_ai_maintenance_rate(v_signal.symbol);
  v_kind := upper(coalesce(v_signal.order_type,'MARKET'));

  perform public.fastboot_validate_terminal_order(
    v_signal.symbol,v_signal.side,v_signal.entry_price,v_quantity,
    p_leverage,v_signal.take_profit,v_signal.stop_loss
  );

  if v_signal.side='LONG' then
    v_liquidation := ((v_signal.entry_price*v_quantity)-v_margin) /
      (v_quantity*(1-v_mmr-0.0001));
  else
    v_liquidation := ((v_signal.entry_price*v_quantity)+v_margin) /
      (v_quantity*(1+v_mmr+0.0001));
  end if;

  select * into v_wallet
  from public.wallets
  where user_id=p_user_id
  for update;
  if not found then raise exception 'Кошелёк пользователя не найден'; end if;
  if coalesce(v_wallet.bot_balance,0)<v_required then
    raise exception 'Недостаточно средств AI Bot Wallet';
  end if;

  update public.wallets
  set bot_balance=bot_balance-v_required,updated_at=now()
  where user_id=p_user_id;

  if v_kind='LIMIT' then
    insert into public.terminal_orders(
      user_id,symbol,side,order_type,price,quantity,reserved_amount,status,created_at,
      leverage,notional,opening_fee,take_profit,stop_loss,
      trade_source,wallet_source,ai_signal_id,ai_mode
    ) values(
      p_user_id,upper(v_signal.symbol),upper(v_signal.side),'LIMIT',
      v_signal.entry_price,v_quantity,v_required,'open',now(),
      p_leverage,v_notional,v_opening_fee,v_signal.take_profit,v_signal.stop_loss,
      'AI','BOT',v_signal.id,'AUTO'
    ) returning id into v_object_id;

    return jsonb_build_object('success',true,'type','LIMIT','id',v_object_id);
  end if;

  insert into public.terminal_positions(
    user_id,symbol,side,entry_price,quantity,margin,status,opened_at,
    take_profit,stop_loss,leverage,notional,opening_fee,
    maintenance_margin_rate,liquidation_price,
    trade_source,wallet_source,ai_signal_id,ai_mode
  ) values(
    p_user_id,upper(v_signal.symbol),upper(v_signal.side),v_signal.entry_price,
    v_quantity,v_margin,'open',now(),v_signal.take_profit,v_signal.stop_loss,
    p_leverage,v_notional,v_opening_fee,v_mmr,greatest(v_liquidation,0),
    'AI','BOT',v_signal.id,'AUTO'
  ) returning id into v_object_id;

  return jsonb_build_object('success',true,'type','MARKET','id',v_object_id);
end;
$$;

-- 5) AUTO LIMIT fill.
create or replace function public.ai_auto_fill_limit_order(
  p_order_id uuid,
  p_fill_price numeric
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_order public.terminal_orders;
  v_wallet public.wallets;
  v_actual_notional numeric;
  v_actual_margin numeric;
  v_actual_fee numeric;
  v_required numeric;
  v_difference numeric;
  v_available numeric;
  v_position_id uuid;
  v_mmr numeric;
  v_liquidation numeric;
begin
  select * into v_order
  from public.terminal_orders
  where id=p_order_id and status='open'
    and trade_source='AI' and ai_mode='AUTO' and wallet_source='BOT'
  for update;
  if not found then raise exception 'AUTO ордер не найден'; end if;

  v_actual_notional := p_fill_price*v_order.quantity;
  v_actual_margin := v_actual_notional/v_order.leverage;
  v_actual_fee := v_actual_notional*0.0001;
  v_required := v_actual_margin+v_actual_fee;
  v_difference := v_order.reserved_amount-v_required;

  select * into v_wallet from public.wallets where user_id=v_order.user_id for update;
  if not found then raise exception 'Кошелёк не найден'; end if;
  v_available := coalesce(v_wallet.bot_balance,0);

  if v_difference<0 and v_available<abs(v_difference) then
    raise exception 'Недостаточно средств для исполнения AUTO LIMIT';
  end if;

  update public.wallets
  set bot_balance=bot_balance+v_difference,updated_at=now()
  where user_id=v_order.user_id;

  v_mmr := public.fastboot_ai_maintenance_rate(v_order.symbol);
  if v_order.side='LONG' then
    v_liquidation := ((p_fill_price*v_order.quantity)-v_actual_margin) /
      (v_order.quantity*(1-v_mmr-0.0001));
  else
    v_liquidation := ((p_fill_price*v_order.quantity)+v_actual_margin) /
      (v_order.quantity*(1+v_mmr+0.0001));
  end if;

  insert into public.terminal_positions(
    user_id,symbol,side,entry_price,quantity,margin,status,opened_at,
    take_profit,stop_loss,leverage,notional,opening_fee,
    maintenance_margin_rate,liquidation_price,
    trade_source,wallet_source,ai_signal_id,ai_mode
  ) values(
    v_order.user_id,v_order.symbol,v_order.side,p_fill_price,v_order.quantity,
    v_actual_margin,'open',now(),v_order.take_profit,v_order.stop_loss,
    v_order.leverage,v_actual_notional,v_actual_fee,v_mmr,greatest(v_liquidation,0),
    'AI','BOT',v_order.ai_signal_id,'AUTO'
  ) returning id into v_position_id;

  update public.terminal_orders set status='filled' where id=p_order_id;
  return v_position_id;
end;
$$;

-- 6) AUTO cancellation refunds BOT wallet.
create or replace function public.ai_auto_cancel_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_order public.terminal_orders;
begin
  select * into v_order
  from public.terminal_orders
  where id=p_order_id and status='open'
    and trade_source='AI' and ai_mode='AUTO' and wallet_source='BOT'
  for update;
  if not found then return p_order_id; end if;

  update public.wallets
  set bot_balance=bot_balance+coalesce(v_order.reserved_amount,0),updated_at=now()
  where user_id=v_order.user_id;

  update public.terminal_orders set status='cancelled' where id=p_order_id;
  return p_order_id;
end;
$$;

-- 7) AUTO close: TP, SL, LIQ, or DAILY_TARGET.
create or replace function public.ai_auto_close_position(
  p_position_id uuid,
  p_exit_price numeric,
  p_close_reason text
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_position public.terminal_positions;
  v_reason text := upper(coalesce(p_close_reason,'MANUAL'));
  v_exit numeric := p_exit_price;
  v_exit_notional numeric;
  v_gross numeric;
  v_close_fee numeric;
  v_net numeric;
  v_return numeric;
  v_pct numeric;
  v_trade_id uuid;
begin
  select * into v_position
  from public.terminal_positions
  where id=p_position_id and status='open'
    and trade_source='AI' and ai_mode='AUTO' and wallet_source='BOT'
  for update;
  if not found then return p_position_id; end if;

  if v_reason not in ('TAKE_PROFIT','STOP_LOSS','LIQUIDATION','DAILY_TARGET','MANUAL') then
    raise exception 'Некорректная причина закрытия AUTO';
  end if;

  if v_reason='LIQUIDATION' and coalesce(v_position.liquidation_price,0)>0 then
    v_exit := v_position.liquidation_price;
  end if;
  if v_exit is null or v_exit<=0 then raise exception 'Некорректная цена выхода'; end if;

  v_exit_notional := v_exit*v_position.quantity;
  v_gross := case when v_position.side='LONG'
    then (v_exit-v_position.entry_price)*v_position.quantity
    else (v_position.entry_price-v_exit)*v_position.quantity end;
  v_close_fee := v_exit_notional*0.0001;

  if v_reason='LIQUIDATION' then
    v_return := 0;
    v_net := -v_position.margin-coalesce(v_position.opening_fee,0);
  else
    v_return := greatest(v_position.margin+v_gross-v_close_fee,0);
    v_net := v_gross-coalesce(v_position.opening_fee,0)-v_close_fee;
  end if;

  v_pct := case when v_position.margin>0 then 100*v_net/v_position.margin else 0 end;

  update public.wallets
  set bot_balance=bot_balance+v_return,updated_at=now()
  where user_id=v_position.user_id;

  update public.terminal_positions
  set status='closed',close_reason=v_reason
  where id=p_position_id;

  insert into public.terminal_trades(
    position_id,user_id,symbol,side,entry_price,exit_price,quantity,pnl,pnl_percent,
    opened_at,closed_at,leverage,margin,notional,gross_pnl,opening_fee,closing_fee,
    net_pnl,take_profit,stop_loss,liquidation_price,maintenance_margin_rate,
    close_reason,trade_source,wallet_source,ai_signal_id,ai_mode
  ) values(
    v_position.id,v_position.user_id,v_position.symbol,v_position.side,
    v_position.entry_price,v_exit,v_position.quantity,v_net,v_pct,
    v_position.opened_at,now(),v_position.leverage,v_position.margin,
    v_position.notional,v_gross,v_position.opening_fee,v_close_fee,v_net,
    v_position.take_profit,v_position.stop_loss,v_position.liquidation_price,
    v_position.maintenance_margin_rate,v_reason,'AI','BOT',
    v_position.ai_signal_id,'AUTO'
  ) returning id into v_trade_id;

  return v_trade_id;
end;
$$;

-- 8) Patch manual AI executor so manual AI trades are explicitly tagged MANUAL.
create or replace function public.execute_ai_manual_signal(
  p_signal_id uuid,
  p_risk_usd numeric,
  p_leverage integer
)
returns jsonb
language plpgsql
security definer
set search_path=public
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
  v_object_id uuid;
  v_max_leverage integer;
  v_kind text;
begin
  if v_user_id is null then raise exception 'Пользователь не авторизован'; end if;
  if p_risk_usd is null or p_risk_usd<=0 then raise exception 'Риск должен быть больше нуля'; end if;

  select * into v_settings from public.ai_assistant_settings where user_id=v_user_id;
  if not found or v_settings.active_mode<>'MANUAL' then
    raise exception 'Сначала включите ручной AI-режим';
  end if;

  select * into v_signal
  from public.ai_manual_signals
  where id=p_signal_id and status='ACTIVE' and valid_until>now()
  for update;
  if not found then raise exception 'Сигнал не найден или больше не активен'; end if;

  v_max_leverage := public.fastboot_ai_max_leverage(v_signal.symbol);
  if p_leverage<1 or p_leverage>v_max_leverage then
    raise exception 'Максимальное плечо для % — x%',v_signal.symbol,v_max_leverage;
  end if;

  v_distance := abs(v_signal.entry_price-v_signal.stop_loss);
  if v_distance<=0 then raise exception 'Некорректный Stop Loss'; end if;
  v_quantity := p_risk_usd/v_distance;

  perform public.fastboot_validate_terminal_order(
    v_signal.symbol,v_signal.side,v_signal.entry_price,v_quantity,
    p_leverage,v_signal.take_profit,v_signal.stop_loss
  );

  v_notional := v_quantity*v_signal.entry_price;
  v_margin := v_notional/p_leverage;
  v_opening_fee := v_notional*0.0001;
  v_required := v_margin+v_opening_fee;
  v_mmr := public.fastboot_ai_maintenance_rate(v_signal.symbol);
  v_kind := upper(coalesce(v_signal.order_type,'MARKET'));

  if v_signal.side='LONG' then
    v_liquidation := ((v_signal.entry_price*v_quantity)-v_margin) /
      (v_quantity*(1-v_mmr-0.0001));
  else
    v_liquidation := ((v_signal.entry_price*v_quantity)+v_margin) /
      (v_quantity*(1+v_mmr+0.0001));
  end if;

  select * into v_wallet from public.wallets where user_id=v_user_id for update;
  if not found then raise exception 'Кошелёк пользователя не найден'; end if;
  if coalesce(v_wallet.bot_balance,0)<v_required then
    raise exception 'Недостаточно средств на AI-счёте';
  end if;

  update public.wallets
  set bot_balance=bot_balance-v_required,updated_at=now()
  where user_id=v_user_id;

  if v_kind='LIMIT' then
    insert into public.terminal_orders(
      user_id,symbol,side,order_type,price,quantity,reserved_amount,status,created_at,
      leverage,notional,opening_fee,take_profit,stop_loss,
      trade_source,wallet_source,ai_signal_id,ai_mode
    ) values(
      v_user_id,upper(v_signal.symbol),upper(v_signal.side),'LIMIT',
      v_signal.entry_price,v_quantity,v_required,'open',now(),
      p_leverage,v_notional,v_opening_fee,v_signal.take_profit,v_signal.stop_loss,
      'AI','BOT',v_signal.id,'MANUAL'
    ) returning id into v_object_id;
  else
    insert into public.terminal_positions(
      user_id,symbol,side,entry_price,quantity,margin,status,opened_at,
      take_profit,stop_loss,leverage,notional,opening_fee,
      maintenance_margin_rate,liquidation_price,
      trade_source,wallet_source,ai_signal_id,ai_mode
    ) values(
      v_user_id,upper(v_signal.symbol),upper(v_signal.side),v_signal.entry_price,
      v_quantity,v_margin,'open',now(),v_signal.take_profit,v_signal.stop_loss,
      p_leverage,v_notional,v_opening_fee,v_mmr,greatest(v_liquidation,0),
      'AI','BOT',v_signal.id,'MANUAL'
    ) returning id into v_object_id;
  end if;

  return jsonb_build_object('success',true,'order_type',v_kind,'id',v_object_id);
end;
$$;

-- 9) Preserve ai_mode when generic limit fill / close handles manual AI.
-- Generic functions from V8/V11 should also carry ai_mode forward.
-- This is done with a trigger so older RPC code cannot accidentally lose the tag.
create or replace function public.fastboot_copy_ai_mode_to_trade()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.ai_mode is null and new.position_id is not null then
    select p.ai_mode into new.ai_mode
    from public.terminal_positions p
    where p.id=new.position_id;
  end if;
  return new;
end;
$$;

drop trigger if exists terminal_trades_copy_ai_mode on public.terminal_trades;
create trigger terminal_trades_copy_ai_mode
before insert on public.terminal_trades
for each row execute function public.fastboot_copy_ai_mode_to_trade();

-- Service RPC permissions.
revoke all on function public.ai_auto_begin_session(uuid,date,numeric,numeric,numeric) from public,anon,authenticated;
revoke all on function public.ai_auto_mark_scan_complete(uuid) from public,anon,authenticated;
revoke all on function public.ai_auto_lock_target(uuid,numeric) from public,anon,authenticated;
revoke all on function public.ai_auto_open_signal(uuid,uuid,numeric,integer) from public,anon,authenticated;
revoke all on function public.ai_auto_fill_limit_order(uuid,numeric) from public,anon,authenticated;
revoke all on function public.ai_auto_cancel_order(uuid) from public,anon,authenticated;
revoke all on function public.ai_auto_close_position(uuid,numeric,text) from public,anon,authenticated;

grant execute on function public.ai_auto_begin_session(uuid,date,numeric,numeric,numeric) to service_role;
grant execute on function public.ai_auto_mark_scan_complete(uuid) to service_role;
grant execute on function public.ai_auto_lock_target(uuid,numeric) to service_role;
grant execute on function public.ai_auto_open_signal(uuid,uuid,numeric,integer) to service_role;
grant execute on function public.ai_auto_fill_limit_order(uuid,numeric) to service_role;
grant execute on function public.ai_auto_cancel_order(uuid) to service_role;
grant execute on function public.ai_auto_close_position(uuid,numeric,text) to service_role;

notify pgrst,'reload schema';
