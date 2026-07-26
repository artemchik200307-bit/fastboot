-- FASTBOOT V8 return-type compatibility hotfix
-- Safe for data: removes only the old RPC definition, not any table rows.
drop function if exists public.cancel_terminal_limit_order(uuid);
notify pgrst, 'reload schema';
