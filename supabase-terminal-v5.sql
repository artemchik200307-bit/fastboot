-- FASTBOOT TERMINAL V5
-- Выполнить один раз в Supabase SQL Editor.
-- Добавляет плечо, комиссии 0.01%, TP/SL для новых ордеров
-- и глобальный минимум пополнения 50 USDT.

create extension if not exists pgcrypto;

alter table public.terminal_positions
  add column if not exists leverage integer not null default 1,
  add column if not exists notional numeric not null default 0,
  add column if not exists opening_fee numeric not null default 0;

alter table public.terminal_orders
  add column if not exists leverage integer not null default 1,
  add column if not exists notional numeric not null default 0,
  add column if not exists opening_fee numeric not null default 0,
  add column if not exists take_profit numeric,
  add column if not exists stop_loss numeric;

alter table public.terminal_trades
  add column if not exists leverage integer not null default 1,
  add column if not exists margin numeric not null default 0,
  add column if not exists notional numeric not null default 0,
  add column if not exists gross_pnl numeric not null default 0,
  add column if not exists opening_fee numeric not null default 0,
  add column if not exists closing_fee numeric not null default 0,
  add column if not exists net_pnl numeric not null default 0,
  add column if not exists take_profit numeric,
  add column if not exists stop_loss numeric;

create or replace function public.fastboot_terminal_max_leverage(
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

create or replace function public.fastboot_validate_terminal_order(
  p_symbol text,
  p_side text,
  p_price numeric,
  p_quantity numeric,
  p_leverage integer,
  p_take_profit numeric,
  p_stop_loss numeric
)
returns void
language plpgsql
as $$
declare
  v_max integer := public.fastboot_terminal_max_leverage(p_symbol);
begin
  if upper(p_side) not in ('LONG','SHORT') then
    raise exception 'Некорректная сторона позиции';
  end if;

  if p_price is null or p_price <= 0 or
     p_quantity is null or p_quantity <= 0 then
    raise exception 'Цена и количество должны быть больше нуля';
  end if;

  if p_leverage is null or p_leverage < 1 or p_leverage > v_max then
    raise exception 'Максимальное плечо для % — x%', upper(p_symbol), v_max;
  end if;

  if p_take_profit is not null and p_take_profit > 0 then
    if upper(p_side) = 'LONG' and p_take_profit <= p_price then
      raise exception 'Для LONG Take Profit должен быть выше цены входа';
    elsif upper(p_side) = 'SHORT' and p_take_profit >= p_price then
      raise exception 'Для SHORT Take Profit должен быть ниже цены входа';
    end if;
  end if;

  if p_stop_loss is not null and p_stop_loss > 0 then
    if upper(p_side) = 'LONG' and p_stop_loss >= p_price then
      raise exception 'Для LONG Stop Loss должен быть ниже цены входа';
    elsif upper(p_side) = 'SHORT' and p_stop_loss <= p_price then
      raise exception 'Для SHORT Stop Loss должен быть выше цены входа';
    end if;
  end if;
end;
$$;

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
set search_path = public
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
  if v_user_id is null then
    raise exception 'Необходимо войти в аккаунт';
  end if;

  perform public.fastboot_validate_terminal_order(
    p_symbol,p_side,p_price,p_quantity,p_leverage,p_take_profit,p_stop_loss
  );

  v_notional := p_price * p_quantity;
  v_margin := v_notional / p_leverage;
  v_open_fee := v_notional * 0.0001;
  v_required := v_margin + v_open_fee;

  select * into v_wallet
  from public.wallets
  where user_id = v_user_id
  for update;

  if not found then
    raise exception 'Кошелёк пользователя не найден';
  end if;

  if coalesce(v_wallet.trading_balance,0) < v_required then
    raise exception 'Недостаточно средств. Нужно % USDT',
      round(v_required,2);
  end if;

  update public.wallets
  set trading_balance = trading_balance - v_required,
      updated_at = now()
  where user_id = v_user_id;

  insert into public.terminal_positions(
    user_id,symbol,side,entry_price,quantity,margin,status,
    opened_at,take_profit,stop_loss,leverage,notional,opening_fee
  )
  values(
    v_user_id,upper(p_symbol),upper(p_side),p_price,p_quantity,v_margin,'open',
    now(),nullif(p_take_profit,0),nullif(p_stop_loss,0),
    p_leverage,v_notional,v_open_fee
  )
  returning id into v_position_id;

  return v_position_id;
end;
$$;

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
set search_path = public
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
  if v_user_id is null then
    raise exception 'Необходимо войти в аккаунт';
  end if;

  perform public.fastboot_validate_terminal_order(
    p_symbol,p_side,p_limit_price,p_quantity,p_leverage,p_take_profit,p_stop_loss
  );

  v_notional := p_limit_price * p_quantity;
  v_margin := v_notional / p_leverage;
  v_open_fee := v_notional * 0.0001;
  v_reserved := v_margin + v_open_fee;

  select * into v_wallet
  from public.wallets
  where user_id = v_user_id
  for update;

  if not found then
    raise exception 'Кошелёк пользователя не найден';
  end if;

  if coalesce(v_wallet.trading_balance,0) < v_reserved then
    raise exception 'Недостаточно средств. Нужно % USDT',
      round(v_reserved,2);
  end if;

  update public.wallets
  set trading_balance = trading_balance - v_reserved,
      updated_at = now()
  where user_id = v_user_id;

  insert into public.terminal_orders(
    user_id,symbol,side,order_type,price,quantity,reserved_amount,status,
    created_at,leverage,notional,opening_fee,take_profit,stop_loss
  )
  values(
    v_user_id,upper(p_symbol),upper(p_side),'LIMIT',p_limit_price,p_quantity,
    v_reserved,'open',now(),p_leverage,v_notional,v_open_fee,
    nullif(p_take_profit,0),nullif(p_stop_loss,0)
  )
  returning id into v_order_id;

  return v_order_id;
end;
$$;

create or replace function public.fill_terminal_limit_order_v2(
  p_order_id uuid,
  p_fill_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.terminal_orders;
  v_actual_notional numeric;
  v_actual_margin numeric;
  v_actual_fee numeric;
  v_required numeric;
  v_difference numeric;
  v_position_id uuid;
begin
  select * into v_order
  from public.terminal_orders
  where id = p_order_id
    and user_id = v_user_id
    and status = 'open'
  for update;

  if not found then
    raise exception 'Открытый ордер не найден';
  end if;

  perform public.fastboot_validate_terminal_order(
    v_order.symbol,v_order.side,p_fill_price,v_order.quantity,
    v_order.leverage,v_order.take_profit,v_order.stop_loss
  );

  v_actual_notional := p_fill_price * v_order.quantity;
  v_actual_margin := v_actual_notional / v_order.leverage;
  v_actual_fee := v_actual_notional * 0.0001;
  v_required := v_actual_margin + v_actual_fee;
  v_difference := v_order.reserved_amount - v_required;

  if v_difference < 0 then
    if (
      select coalesce(trading_balance,0)
      from public.wallets
      where user_id = v_user_id
      for update
    ) < abs(v_difference) then
      raise exception 'Недостаточно средств для исполнения ордера';
    end if;
  end if;

  update public.wallets
  set trading_balance = trading_balance + v_difference,
      updated_at = now()
  where user_id = v_user_id;

  insert into public.terminal_positions(
    user_id,symbol,side,entry_price,quantity,margin,status,
    opened_at,take_profit,stop_loss,leverage,notional,opening_fee
  )
  values(
    v_user_id,v_order.symbol,v_order.side,p_fill_price,v_order.quantity,
    v_actual_margin,'open',now(),v_order.take_profit,v_order.stop_loss,
    v_order.leverage,v_actual_notional,v_actual_fee
  )
  returning id into v_position_id;

  update public.terminal_orders
  set status = 'filled'
  where id = p_order_id;

  return v_position_id;
end;
$$;

create or replace function public.close_terminal_position_v2(
  p_position_id uuid,
  p_exit_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_position public.terminal_positions;
  v_exit_notional numeric;
  v_gross_pnl numeric;
  v_close_fee numeric;
  v_net_pnl numeric;
  v_return_amount numeric;
  v_pnl_percent numeric;
  v_trade_id uuid;
begin
  select * into v_position
  from public.terminal_positions
  where id = p_position_id
    and user_id = v_user_id
    and status = 'open'
  for update;

  if not found then
    raise exception 'Открытая позиция не найдена';
  end if;

  if p_exit_price is null or p_exit_price <= 0 then
    raise exception 'Некорректная цена закрытия';
  end if;

  v_exit_notional := p_exit_price * v_position.quantity;

  v_gross_pnl := case
    when v_position.side = 'LONG'
      then (p_exit_price - v_position.entry_price) * v_position.quantity
    else (v_position.entry_price - p_exit_price) * v_position.quantity
  end;

  v_close_fee := v_exit_notional * 0.0001;
  v_net_pnl :=
    v_gross_pnl -
    coalesce(v_position.opening_fee,0) -
    v_close_fee;

  -- Открывающая комиссия уже была списана отдельно.
  -- Возвращаем маржу + изменение цены - комиссия закрытия.
  v_return_amount :=
    greatest(
      v_position.margin + v_gross_pnl - v_close_fee,
      0
    );

  v_pnl_percent := case
    when v_position.margin > 0
      then (v_net_pnl / v_position.margin) * 100
    else 0
  end;

  update public.wallets
  set trading_balance = trading_balance + v_return_amount,
      updated_at = now()
  where user_id = v_user_id;

  update public.terminal_positions
  set status = 'closed'
  where id = p_position_id;

  insert into public.terminal_trades(
    user_id,symbol,side,entry_price,exit_price,quantity,pnl,pnl_percent,
    closed_at,leverage,margin,notional,gross_pnl,opening_fee,closing_fee,
    net_pnl,take_profit,stop_loss
  )
  values(
    v_user_id,v_position.symbol,v_position.side,v_position.entry_price,
    p_exit_price,v_position.quantity,v_net_pnl,v_pnl_percent,now(),
    v_position.leverage,v_position.margin,v_position.notional,v_gross_pnl,
    v_position.opening_fee,v_close_fee,v_net_pnl,
    v_position.take_profit,v_position.stop_loss
  )
  returning id into v_trade_id;

  return v_trade_id;
end;
$$;

grant execute on function public.open_terminal_market_position_v2(
  text,text,numeric,numeric,integer,numeric,numeric
) to authenticated;

grant execute on function public.create_terminal_limit_order_v2(
  text,text,numeric,numeric,integer,numeric,numeric
) to authenticated;

grant execute on function public.fill_terminal_limit_order_v2(
  uuid,numeric
) to authenticated;

grant execute on function public.close_terminal_position_v2(
  uuid,numeric
) to authenticated;

-- Глобальный минимум внешнего пополнения: 50 USDT.
create or replace function public.fastboot_enforce_min_deposit()
returns trigger
language plpgsql
as $$
begin
  if new.type = 'deposit' and new.amount < 50 then
    raise exception 'Минимальная сумма пополнения составляет 50 USDT';
  end if;

  return new;
end;
$$;

drop trigger if exists fastboot_min_deposit_50
on public.funding_requests;

create trigger fastboot_min_deposit_50
before insert or update of amount,type
on public.funding_requests
for each row
execute function public.fastboot_enforce_min_deposit();
