-- FASTBOOT V7: разделение AUTO/MANUAL, статистика ручной торговли и админ-отчёты.
-- Выполнить в Supabase SQL Editor после предыдущих миграций.

alter table if exists public.user_ai_trade_results
  add column if not exists trade_source text not null default 'AUTO';

update public.user_ai_trade_results
set trade_source = 'AUTO'
where trade_source is null or upper(trade_source) not in ('AUTO','MANUAL');

alter table public.user_ai_trade_results
  drop constraint if exists user_ai_trade_results_trade_source_check;
alter table public.user_ai_trade_results
  add constraint user_ai_trade_results_trade_source_check
  check (trade_source in ('AUTO','MANUAL'));

create index if not exists user_ai_trade_results_source_idx
  on public.user_ai_trade_results(user_id, trade_source, created_at desc);
create index if not exists ai_manual_positions_admin_idx
  on public.ai_manual_positions(status, opened_at desc);

create or replace function public.fastboot_require_admin()
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.profiles where id=auth.uid() and role='admin'
  ) then raise exception 'Недостаточно прав администратора'; end if;
end; $$;

create or replace function public.admin_manual_trading_overview()
returns jsonb language plpgsql security definer set search_path=public as $$
declare v jsonb;
begin
  perform public.fastboot_require_admin();
  select jsonb_build_object(
    'users_count', count(distinct user_id),
    'open_positions_count', count(*) filter(where status='OPEN'),
    'closed_trades_count', count(*) filter(where status='CLOSED'),
    'winning_trades_count', count(*) filter(where status='CLOSED' and coalesce(net_pnl,0)>0),
    'win_rate', case when count(*) filter(where status='CLOSED')=0 then 0 else round(100.0*count(*) filter(where status='CLOSED' and coalesce(net_pnl,0)>0)/count(*) filter(where status='CLOSED'),2) end,
    'total_notional', coalesce(sum(notional),0),
    'gross_pnl', coalesce(sum(gross_pnl) filter(where status='CLOSED'),0),
    'total_fees', coalesce(sum(coalesce(opening_fee,0)+coalesce(platform_fee,0)),0),
    'net_pnl', coalesce(sum(net_pnl) filter(where status='CLOSED'),0)
  ) into v from public.ai_manual_positions;
  return v;
end; $$;

create or replace function public.admin_list_manual_trades(p_status text default null,p_limit integer default 500,p_offset integer default 0)
returns table(id uuid,user_id uuid,username text,email text,fastboot_id text,symbol text,side text,status text,entry_price numeric,exit_price numeric,stop_loss numeric,take_profit numeric,quantity numeric,notional numeric,margin numeric,leverage integer,gross_pnl numeric,platform_fee numeric,opening_fee numeric,net_pnl numeric,opened_at timestamptz,closed_at timestamptz,close_reason text)
language plpgsql security definer set search_path=public as $$
begin
  perform public.fastboot_require_admin();
  return query select m.id,m.user_id,p.username,u.email::text,p.fastboot_id,m.symbol,m.side,m.status,m.entry_price,m.exit_price,m.stop_loss,m.take_profit,m.quantity,m.notional,m.margin,m.leverage,m.gross_pnl,m.platform_fee,m.opening_fee,m.net_pnl,m.opened_at,m.closed_at,m.close_reason
  from public.ai_manual_positions m left join public.profiles p on p.id=m.user_id left join auth.users u on u.id=m.user_id
  where p_status is null or m.status=upper(p_status)
  order by coalesce(m.closed_at,m.opened_at) desc limit greatest(1,least(p_limit,1000)) offset greatest(p_offset,0);
end; $$;

create or replace function public.admin_get_user_manual_trading(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_stats jsonb; v_rows jsonb;
begin
  perform public.fastboot_require_admin();
  select jsonb_build_object('open_positions_count',count(*) filter(where status='OPEN'),'closed_trades_count',count(*) filter(where status='CLOSED'),'gross_pnl',coalesce(sum(gross_pnl) filter(where status='CLOSED'),0),'total_fees',coalesce(sum(coalesce(opening_fee,0)+coalesce(platform_fee,0)),0),'net_pnl',coalesce(sum(net_pnl) filter(where status='CLOSED'),0)) into v_stats from public.ai_manual_positions where user_id=p_user_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by coalesce(x.closed_at,x.opened_at) desc),'[]'::jsonb) into v_rows from (select * from public.ai_manual_positions where user_id=p_user_id) x;
  return jsonb_build_object('statistics',v_stats,'positions',v_rows);
end; $$;

grant execute on function public.admin_manual_trading_overview() to authenticated;
grant execute on function public.admin_list_manual_trades(text,integer,integer) to authenticated;
grant execute on function public.admin_get_user_manual_trading(uuid) to authenticated;
