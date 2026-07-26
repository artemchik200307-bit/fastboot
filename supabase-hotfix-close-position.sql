-- FASTBOOT hotfix: restore close_terminal_position_v3 RPC
-- Run this file in Supabase SQL Editor once.
-- Fixes: Could not find public.close_terminal_position_v3(...) in schema cache.

create or replace function public.close_terminal_position_v3(
  p_position_id uuid,
  p_exit_price numeric,
  p_close_reason text default 'MANUAL'
)
returns uuid
language plpgsql
security definer
set search_path = public
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
  where id = p_position_id
    and user_id = v_user_id
    and status = 'open'
  for update;

  if not found then
    raise exception 'Открытая позиция не найдена';
  end if;

  if v_reason not in ('MANUAL','TAKE_PROFIT','STOP_LOSS','LIQUIDATION') then
    raise exception 'Некорректная причина закрытия';
  end if;

  v_exit_price := p_exit_price;

  if v_reason = 'LIQUIDATION' then
    v_exit_price := coalesce(
      v_position.liquidation_price,
      public.fastboot_liquidation_price(
        v_position.symbol,
        v_position.side,
        v_position.entry_price,
        v_position.quantity,
        v_position.margin,
        0.0001
      )
    );
  end if;

  if v_exit_price is null or v_exit_price <= 0 then
    raise exception 'Некорректная цена закрытия';
  end if;

  v_exit_notional := v_exit_price * v_position.quantity;

  v_gross_pnl := case
    when v_position.side = 'LONG'
      then (v_exit_price - v_position.entry_price) * v_position.quantity
    else (v_position.entry_price - v_exit_price) * v_position.quantity
  end;

  v_close_fee := v_exit_notional * 0.0001;
  v_net_pnl :=
    v_gross_pnl -
    coalesce(v_position.opening_fee,0) -
    v_close_fee;

  if v_reason = 'LIQUIDATION' then
    -- При изолированной ликвидации залог позиции считается потерянным.
    v_return_amount := 0;
    v_net_pnl := -v_position.margin - coalesce(v_position.opening_fee,0);
  else
    v_return_amount :=
      greatest(
        v_position.margin + v_gross_pnl - v_close_fee,
        0
      );
  end if;

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
  set
    status = 'closed',
    close_reason = v_reason
  where id = p_position_id;

  insert into public.terminal_trades(
    position_id,user_id,symbol,side,entry_price,exit_price,quantity,pnl,pnl_percent,
    opened_at,closed_at,leverage,margin,notional,gross_pnl,opening_fee,closing_fee,
    net_pnl,take_profit,stop_loss,liquidation_price,maintenance_margin_rate,
    close_reason
  )
  values(
    v_position.id,v_user_id,v_position.symbol,v_position.side,
    v_position.entry_price,v_exit_price,v_position.quantity,v_net_pnl,
    v_pnl_percent,coalesce(v_position.opened_at,now()),now(),
    v_position.leverage,v_position.margin,v_position.notional,v_gross_pnl,
    v_position.opening_fee,v_close_fee,v_net_pnl,
    v_position.take_profit,v_position.stop_loss,
    v_position.liquidation_price,v_position.maintenance_margin_rate,
    v_reason
  )
  returning id into v_trade_id;

  return v_trade_id;
end;
$$;

grant execute on function public.close_terminal_position_v3(
  uuid,numeric,text
) to authenticated;


-- Ask PostgREST to reload its schema cache immediately.
notify pgrst, 'reload schema';
