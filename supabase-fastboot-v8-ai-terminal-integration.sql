-- FASTBOOT V8
-- AI manual signals -> common terminal, isolated AI Bot Wallet funding,
-- AI trade markers, source-aware market/limit/close/cancel/TP-SL functions.
-- Run AFTER previous FASTBOOT terminal + V6/V7 migrations.

create extension if not exists pgcrypto;

-- 1) Shared terminal rows now know who created/funds the trade.
alter table public.terminal_positions
  add column if not exists trade_source text not null default 'MANUAL',
  add column if not exists wallet_source text not null default 'TERMINAL',
  add column if not exists ai_signal_id uuid;

alter table public.terminal_orders
  add column if not exists trade_source text not null default 'MANUAL',
  add column if not exists wallet_source text not null default 'TERMINAL',
  add column if not exists ai_signal_id uuid;

alter table public.terminal_trades
  add column if not exists trade_source text not null default 'MANUAL',
  add column if not exists wallet_source text not null default 'TERMINAL',
  add column if not exists ai_signal_id uuid;

update public.terminal_positions
set trade_source='MANUAL', wallet_source='TERMINAL'
where trade_source is null or wallet_source is null;

update public.terminal_orders
set trade_source='MANUAL', wallet_source='TERMINAL'
where trade_source is null or wallet_source is null;

update public.terminal_trades
set trade_source='MANUAL', wallet_source='TERMINAL'
where trade_source is null or wallet_source is null;

alter table public.terminal_positions drop constraint if exists terminal_positions_trade_source_check;
alter table public.terminal_positions add constraint terminal_positions_trade_source_check
  check (trade_source in ('MANUAL','AI'));
alter table public.terminal_positions drop constraint if exists terminal_positions_wallet_source_check;
alter table public.terminal_positions add constraint terminal_positions_wallet_source_check
  check (wallet_source in ('TERMINAL','BOT'));

alter table public.terminal_orders drop constraint if exists terminal_orders_trade_source_check;
alter table public.terminal_orders add constraint terminal_orders_trade_source_check
  check (trade_source in ('MANUAL','AI'));
alter table public.terminal_orders drop constraint if exists terminal_orders_wallet_source_check;
alter table public.terminal_orders add constraint terminal_orders_wallet_source_check
  check (wallet_source in ('TERMINAL','BOT'));

alter table public.terminal_trades drop constraint if exists terminal_trades_trade_source_check;
alter table public.terminal_trades add constraint terminal_trades_trade_source_check
  check (trade_source in ('MANUAL','AI'));
alter table public.terminal_trades drop constraint if exists terminal_trades_wallet_source_check;
alter table public.terminal_trades add constraint terminal_trades_wallet_source_check
  check (wallet_source in ('TERMINAL','BOT'));

create index if not exists terminal_positions_source_idx
  on public.terminal_positions(user_id,trade_source,status,opened_at desc);
create index if not exists terminal_orders_source_idx
  on public.terminal_orders(user_id,trade_source,status,created_at desc);
create index if not exists terminal_trades_source_idx
  on public.terminal_trades(user_id,trade_source,closed_at desc);

-- 2) Normal terminal MARKET orders remain funded ONLY from trading_balance.
create or replace function public.open_terminal_market_position_v2(
  p_symbol text,
  p_side text,
  p_price numeric,
  p_quantity numeric,
  p_leverage integer default 1,
  p_take_profit numeric default null,
  p_stop_loss numeric default null
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallets;
  v_notional numeric;
  v_margin numeric;
  v_open_fee numeric;
  v_required numeric;
  v_position_id uuid;
begin
  if v_user_id is null then raise exception 'Необходимо войти в аккаунт'; end if;

  perform public.fastboot_validate_terminal_order(
    p_symbol,p_side,p_price,p_quantity,p_leverage,p_take_profit,p_stop_loss
  );

  v_notional := p_price*p_quantity;
  v_margin := v_notional/p_leverage;
  v_open_fee := v_notional*0.0001;
  v_required := v_margin+v_open_fee;

  select * into v_wallet from public.wallets where user_id=v_user_id for update;
  if not found then raise exception 'Кошелёк пользователя не найден'; end if;
  if coalesce(v_wallet.trading_balance,0) < v_required then
    raise exception 'Недостаточно средств на счёте терминала. Нужно % USDT',round(v_required,2);
  end if;

  update public.wallets
  set trading_balance=trading_balance-v_required,updated_at=now()
  where user_id=v_user_id;

  insert into public.terminal_positions(
    user_id,symbol,side,entry_price,quantity,margin,status,opened_at,
    take_profit,stop_loss,leverage,notional,opening_fee,
    trade_source,wallet_source,ai_signal_id
  ) values(
    v_user_id,upper(p_symbol),upper(p_side),p_price,p_quantity,v_margin,'open',now(),
    nullif(p_take_profit,0),nullif(p_stop_loss,0),p_leverage,v_notional,v_open_fee,
    'MANUAL','TERMINAL',null
  ) returning id into v_position_id;

  return v_position_id;
end;
$$;

-- 3) Normal terminal LIMIT orders remain funded ONLY from trading_balance.
create or replace function public.create_terminal_limit_order_v2(
  p_symbol text,
  p_side text,
  p_limit_price numeric,
  p_quantity numeric,
  p_leverage integer default 1,
  p_take_profit numeric default null,
  p_stop_loss numeric default null
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallets;
  v_notional numeric;
  v_margin numeric;
  v_open_fee numeric;
  v_reserved numeric;
  v_order_id uuid;
begin
  if v_user_id is null then raise exception 'Необходимо войти в аккаунт'; end if;

  perform public.fastboot_validate_terminal_order(
    p_symbol,p_side,p_limit_price,p_quantity,p_leverage,p_take_profit,p_stop_loss
  );

  v_notional := p_limit_price*p_quantity;
  v_margin := v_notional/p_leverage;
  v_open_fee := v_notional*0.0001;
  v_reserved := v_margin+v_open_fee;

  select * into v_wallet from public.wallets where user_id=v_user_id for update;
  if not found then raise exception 'Кошелёк пользователя не найден'; end if;
  if coalesce(v_wallet.trading_balance,0) < v_reserved then
    raise exception 'Недостаточно средств на счёте терминала. Нужно % USDT',round(v_reserved,2);
  end if;

  update public.wallets
  set trading_balance=trading_balance-v_reserved,updated_at=now()
  where user_id=v_user_id;

  insert into public.terminal_orders(
    user_id,symbol,side,order_type,price,quantity,reserved_amount,status,created_at,
    leverage,notional,opening_fee,take_profit,stop_loss,
    trade_source,wallet_source,ai_signal_id
  ) values(
    v_user_id,upper(p_symbol),upper(p_side),'LIMIT',p_limit_price,p_quantity,
    v_reserved,'open',now(),p_leverage,v_notional,v_open_fee,
    nullif(p_take_profit,0),nullif(p_stop_loss,0),'MANUAL','TERMINAL',null
  ) returning id into v_order_id;

  return v_order_id;
end;
$$;

-- 4) Opening a signal in MANUAL AI mode creates a real terminal position/order,
-- but reserves money ONLY from bot_balance.
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

  perform public.fastboot_validate_terminal_order(
    v_signal.symbol,v_signal.side,v_signal.entry_price,
    greatest(p_risk_usd/abs(v_signal.entry_price-v_signal.stop_loss),0),
    p_leverage,v_signal.take_profit,v_signal.stop_loss
  );

  v_distance := abs(v_signal.entry_price-v_signal.stop_loss);
  if v_distance<=0 then raise exception 'Некорректный Stop Loss'; end if;

  v_quantity := p_risk_usd/v_distance;
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
    raise exception 'Недостаточно средств на AI-счёте. Нужно % USDT',round(v_required,2);
  end if;

  update public.wallets
  set bot_balance=bot_balance-v_required,updated_at=now()
  where user_id=v_user_id;

  if v_kind='LIMIT' then
    insert into public.terminal_orders(
      user_id,symbol,side,order_type,price,quantity,reserved_amount,status,created_at,
      leverage,notional,opening_fee,take_profit,stop_loss,
      trade_source,wallet_source,ai_signal_id
    ) values(
      v_user_id,upper(v_signal.symbol),upper(v_signal.side),'LIMIT',v_signal.entry_price,
      v_quantity,v_required,'open',now(),p_leverage,v_notional,v_opening_fee,
      v_signal.take_profit,v_signal.stop_loss,'AI','BOT',v_signal.id
    ) returning id into v_object_id;

    return jsonb_build_object(
      'success',true,'order_type','LIMIT','order_id',v_object_id,
      'quantity',v_quantity,'notional',v_notional,'margin',v_margin,
      'reserved',v_required,'opening_fee',v_opening_fee
    );
  end if;

  insert into public.terminal_positions(
    user_id,symbol,side,entry_price,quantity,margin,status,opened_at,
    take_profit,stop_loss,leverage,notional,opening_fee,
    maintenance_margin_rate,liquidation_price,
    trade_source,wallet_source,ai_signal_id
  ) values(
    v_user_id,upper(v_signal.symbol),upper(v_signal.side),v_signal.entry_price,
    v_quantity,v_margin,'open',now(),v_signal.take_profit,v_signal.stop_loss,
    p_leverage,v_notional,v_opening_fee,v_mmr,greatest(v_liquidation,0),
    'AI','BOT',v_signal.id
  ) returning id into v_object_id;

  return jsonb_build_object(
    'success',true,'order_type','MARKET','position_id',v_object_id,
    'quantity',v_quantity,'notional',v_notional,'margin',v_margin,
    'liquidation_price',greatest(v_liquidation,0),'opening_fee',v_opening_fee
  );
end;
$$;

-- 5) LIMIT fill follows the order funding source.
create or replace function public.fill_terminal_limit_order_v2(
  p_order_id uuid,
  p_fill_price numeric
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.terminal_orders;
  v_wallet public.wallets;
  v_actual_notional numeric;
  v_actual_margin numeric;
  v_actual_fee numeric;
  v_required numeric;
  v_difference numeric;
  v_available numeric;
  v_position_id uuid;
begin
  if v_user_id is null then raise exception 'Необходимо войти в аккаунт'; end if;

  select * into v_order
  from public.terminal_orders
  where id=p_order_id and user_id=v_user_id and status='open'
  for update;
  if not found then raise exception 'Открытый ордер не найден'; end if;

  perform public.fastboot_validate_terminal_order(
    v_order.symbol,v_order.side,p_fill_price,v_order.quantity,
    v_order.leverage,v_order.take_profit,v_order.stop_loss
  );

  v_actual_notional := p_fill_price*v_order.quantity;
  v_actual_margin := v_actual_notional/v_order.leverage;
  v_actual_fee := v_actual_notional*0.0001;
  v_required := v_actual_margin+v_actual_fee;
  v_difference := v_order.reserved_amount-v_required;

  select * into v_wallet from public.wallets where user_id=v_user_id for update;
  if not found then raise exception 'Кошелёк пользователя не найден'; end if;

  v_available := case when v_order.wallet_source='BOT'
    then coalesce(v_wallet.bot_balance,0)
    else coalesce(v_wallet.trading_balance,0) end;

  if v_difference<0 and v_available<abs(v_difference) then
    raise exception 'Недостаточно средств для исполнения ордера';
  end if;

  if v_order.wallet_source='BOT' then
    update public.wallets set bot_balance=bot_balance+v_difference,updated_at=now()
    where user_id=v_user_id;
  else
    update public.wallets set trading_balance=trading_balance+v_difference,updated_at=now()
    where user_id=v_user_id;
  end if;

  insert into public.terminal_positions(
    user_id,symbol,side,entry_price,quantity,margin,status,opened_at,
    take_profit,stop_loss,leverage,notional,opening_fee,
    trade_source,wallet_source,ai_signal_id
  ) values(
    v_user_id,v_order.symbol,v_order.side,p_fill_price,v_order.quantity,
    v_actual_margin,'open',now(),v_order.take_profit,v_order.stop_loss,
    v_order.leverage,v_actual_notional,v_actual_fee,
    v_order.trade_source,v_order.wallet_source,v_order.ai_signal_id
  ) returning id into v_position_id;

  update public.terminal_orders set status='filled' where id=p_order_id;
  return v_position_id;
end;
$$;

-- 6) Cancel returns reserved funds to the same wallet that funded the order.
-- V8 hotfix: the previous database version may have this RPC with another
-- return type. PostgreSQL cannot change a function return type with
-- CREATE OR REPLACE, so remove only the old RPC definition first.
-- This does NOT delete orders, positions, trades, wallets, or history.
drop function if exists public.cancel_terminal_limit_order(uuid);

create or replace function public.cancel_terminal_limit_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.terminal_orders;
begin
  select * into v_order
  from public.terminal_orders
  where id=p_order_id and user_id=v_user_id and status='open'
  for update;
  if not found then raise exception 'Открытый ордер не найден'; end if;

  if v_order.wallet_source='BOT' then
    update public.wallets
    set bot_balance=bot_balance+coalesce(v_order.reserved_amount,0),updated_at=now()
    where user_id=v_user_id;
  else
    update public.wallets
    set trading_balance=trading_balance+coalesce(v_order.reserved_amount,0),updated_at=now()
    where user_id=v_user_id;
  end if;

  update public.terminal_orders set status='cancelled' where id=p_order_id;
  return p_order_id;
end;
$$;

-- 7) TP/SL editor works identically for MANUAL and AI positions.
create or replace function public.set_terminal_position_protection(
  p_position_id uuid,
  p_take_profit numeric default null,
  p_stop_loss numeric default null
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user_id uuid := auth.uid();
  v_position public.terminal_positions;
begin
  select * into v_position
  from public.terminal_positions
  where id=p_position_id and user_id=v_user_id and status='open'
  for update;
  if not found then raise exception 'Открытая позиция не найдена'; end if;

  perform public.fastboot_validate_terminal_order(
    v_position.symbol,v_position.side,v_position.entry_price,v_position.quantity,
    v_position.leverage,p_take_profit,p_stop_loss
  );

  update public.terminal_positions
  set take_profit=nullif(p_take_profit,0),stop_loss=nullif(p_stop_loss,0)
  where id=p_position_id;

  return p_position_id;
end;
$$;

-- 8) Closing a position credits ONLY the wallet that funded it.
create or replace function public.close_terminal_position_v3(
  p_position_id uuid,
  p_exit_price numeric,
  p_close_reason text default 'MANUAL'
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user_id uuid := auth.uid();
  v_position public.terminal_positions;
  v_exit_price numeric;
  v_exit_notional numeric;
  v_gross_pnl numeric;
  v_close_fee numeric;
  v_net_pnl numeric;
  v_return_amount numeric;
  v_pnl_percent numeric;
  v_trade_id uuid;
  v_reason text := upper(coalesce(p_close_reason,'MANUAL'));
begin
  select * into v_position
  from public.terminal_positions
  where id=p_position_id and user_id=v_user_id and status='open'
  for update;
  if not found then raise exception 'Открытая позиция не найдена'; end if;

  if v_reason not in ('MANUAL','TAKE_PROFIT','STOP_LOSS','LIQUIDATION') then
    raise exception 'Некорректная причина закрытия';
  end if;

  v_exit_price := p_exit_price;
  if v_reason='LIQUIDATION' then
    v_exit_price := coalesce(v_position.liquidation_price,
      public.fastboot_liquidation_price(
        v_position.symbol,v_position.side,v_position.entry_price,
        v_position.quantity,v_position.margin,0.0001
      ));
  end if;
  if v_exit_price is null or v_exit_price<=0 then raise exception 'Некорректная цена закрытия'; end if;

  v_exit_notional := v_exit_price*v_position.quantity;
  v_gross_pnl := case when v_position.side='LONG'
    then (v_exit_price-v_position.entry_price)*v_position.quantity
    else (v_position.entry_price-v_exit_price)*v_position.quantity end;
  v_close_fee := v_exit_notional*0.0001;
  v_net_pnl := v_gross_pnl-coalesce(v_position.opening_fee,0)-v_close_fee;

  if v_reason='LIQUIDATION' then
    v_return_amount := 0;
    v_net_pnl := -v_position.margin-coalesce(v_position.opening_fee,0);
  else
    v_return_amount := greatest(v_position.margin+v_gross_pnl-v_close_fee,0);
  end if;

  v_pnl_percent := case when v_position.margin>0
    then (v_net_pnl/v_position.margin)*100 else 0 end;

  if v_position.wallet_source='BOT' then
    update public.wallets set bot_balance=bot_balance+v_return_amount,updated_at=now()
    where user_id=v_user_id;
  else
    update public.wallets set trading_balance=trading_balance+v_return_amount,updated_at=now()
    where user_id=v_user_id;
  end if;

  update public.terminal_positions
  set status='closed',close_reason=v_reason
  where id=p_position_id;

  insert into public.terminal_trades(
    position_id,user_id,symbol,side,entry_price,exit_price,quantity,pnl,pnl_percent,
    opened_at,closed_at,leverage,margin,notional,gross_pnl,opening_fee,closing_fee,
    net_pnl,take_profit,stop_loss,liquidation_price,maintenance_margin_rate,close_reason,
    trade_source,wallet_source,ai_signal_id
  ) values(
    v_position.id,v_user_id,v_position.symbol,v_position.side,
    v_position.entry_price,v_exit_price,v_position.quantity,v_net_pnl,v_pnl_percent,
    coalesce(v_position.opened_at,now()),now(),v_position.leverage,v_position.margin,
    v_position.notional,v_gross_pnl,v_position.opening_fee,v_close_fee,v_net_pnl,
    v_position.take_profit,v_position.stop_loss,v_position.liquidation_price,
    v_position.maintenance_margin_rate,v_reason,
    v_position.trade_source,v_position.wallet_source,v_position.ai_signal_id
  ) returning id into v_trade_id;

  return v_trade_id;
end;
$$;

-- 9) Admin manual-AI stats now use the SAME real terminal records.
create or replace function public.admin_manual_trading_overview()
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_open bigint;
  v_closed bigint;
  v_wins bigint;
  v_users bigint;
  v_notional numeric;
  v_gross numeric;
  v_fees numeric;
  v_net numeric;
begin
  perform public.fastboot_require_admin();

  select count(*),count(distinct user_id),coalesce(sum(notional),0)
  into v_open,v_users,v_notional
  from public.terminal_positions
  where trade_source='AI' and status='open';

  select count(*),count(*) filter(where coalesce(net_pnl,pnl,0)>0),
         coalesce(sum(gross_pnl),0),
         coalesce(sum(coalesce(opening_fee,0)+coalesce(closing_fee,0)),0),
         coalesce(sum(coalesce(net_pnl,pnl,0)),0)
  into v_closed,v_wins,v_gross,v_fees,v_net
  from public.terminal_trades
  where trade_source='AI';

  return jsonb_build_object(
    'users_count',v_users,
    'open_positions_count',v_open,
    'closed_trades_count',v_closed,
    'winning_trades_count',v_wins,
    'win_rate',case when v_closed=0 then 0 else round(100.0*v_wins/v_closed,2) end,
    'total_notional',v_notional,
    'gross_pnl',v_gross,
    'total_fees',v_fees,
    'net_pnl',v_net
  );
end;
$$;

-- Keep previous admin_list_manual_trades contract, combining open + closed AI terminal rows.
create or replace function public.admin_list_manual_trades(
  p_status text default null,
  p_limit integer default 500,
  p_offset integer default 0
)
returns table(
  id uuid,user_id uuid,username text,email text,fastboot_id text,
  symbol text,side text,status text,entry_price numeric,exit_price numeric,
  stop_loss numeric,take_profit numeric,quantity numeric,notional numeric,
  margin numeric,leverage integer,gross_pnl numeric,platform_fee numeric,
  opening_fee numeric,net_pnl numeric,opened_at timestamptz,closed_at timestamptz,
  close_reason text
)
language plpgsql
security definer
set search_path=public
as $$
begin
  perform public.fastboot_require_admin();
  return query
  with rows as (
    select p.id,p.user_id,p.symbol,p.side,'OPEN'::text status,p.entry_price,
      null::numeric exit_price,p.stop_loss,p.take_profit,p.quantity,p.notional,
      p.margin,p.leverage,null::numeric gross_pnl,0::numeric platform_fee,
      p.opening_fee,null::numeric net_pnl,p.opened_at,null::timestamptz closed_at,
      null::text close_reason
    from public.terminal_positions p
    where p.trade_source='AI' and p.status='open'
    union all
    select t.id,t.user_id,t.symbol,t.side,'CLOSED'::text,t.entry_price,t.exit_price,
      t.stop_loss,t.take_profit,t.quantity,t.notional,t.margin,t.leverage,t.gross_pnl,
      t.closing_fee,t.opening_fee,coalesce(t.net_pnl,t.pnl),t.opened_at,t.closed_at,t.close_reason
    from public.terminal_trades t
    where t.trade_source='AI'
  )
  select r.id,r.user_id,p.username,u.email::text,p.fastboot_id,r.symbol,r.side,r.status,
    r.entry_price,r.exit_price,r.stop_loss,r.take_profit,r.quantity,r.notional,r.margin,
    r.leverage,r.gross_pnl,r.platform_fee,r.opening_fee,r.net_pnl,r.opened_at,r.closed_at,
    r.close_reason
  from rows r
  left join public.profiles p on p.id=r.user_id
  left join auth.users u on u.id=r.user_id
  where p_status is null or r.status=upper(p_status)
  order by coalesce(r.closed_at,r.opened_at) desc
  limit greatest(1,least(p_limit,1000)) offset greatest(p_offset,0);
end;
$$;

create or replace function public.admin_get_user_manual_trading(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_stats jsonb;
  v_rows jsonb;
begin
  perform public.fastboot_require_admin();

  select jsonb_build_object(
    'open_positions_count',(select count(*) from public.terminal_positions where user_id=p_user_id and trade_source='AI' and status='open'),
    'closed_trades_count',count(*),
    'gross_pnl',coalesce(sum(gross_pnl),0),
    'total_fees',coalesce(sum(coalesce(opening_fee,0)+coalesce(closing_fee,0)),0),
    'net_pnl',coalesce(sum(coalesce(net_pnl,pnl,0)),0)
  ) into v_stats
  from public.terminal_trades
  where user_id=p_user_id and trade_source='AI';

  select coalesce(jsonb_agg(to_jsonb(x) order by x.closed_at desc),'[]'::jsonb)
  into v_rows
  from (
    select * from public.terminal_trades
    where user_id=p_user_id and trade_source='AI'
  ) x;

  return jsonb_build_object('statistics',v_stats,'positions',v_rows);
end;
$$;

grant execute on function public.open_terminal_market_position_v2(text,text,numeric,numeric,integer,numeric,numeric) to authenticated;
grant execute on function public.create_terminal_limit_order_v2(text,text,numeric,numeric,integer,numeric,numeric) to authenticated;
grant execute on function public.execute_ai_manual_signal(uuid,numeric,integer) to authenticated;
grant execute on function public.fill_terminal_limit_order_v2(uuid,numeric) to authenticated;
grant execute on function public.cancel_terminal_limit_order(uuid) to authenticated;
grant execute on function public.set_terminal_position_protection(uuid,numeric,numeric) to authenticated;
grant execute on function public.close_terminal_position_v3(uuid,numeric,text) to authenticated;
grant execute on function public.admin_manual_trading_overview() to authenticated;
grant execute on function public.admin_list_manual_trades(text,integer,integer) to authenticated;
grant execute on function public.admin_get_user_manual_trading(uuid) to authenticated;

notify pgrst,'reload schema';
