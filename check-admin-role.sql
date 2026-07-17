-- FASTBOOT ADMIN ROLE CHECK
-- Сначала посмотри свою роль:
select id, email, username, role
from public.profiles
order by created_at desc;

-- Чтобы назначить конкретный аккаунт администратором,
-- замени EMAIL_АДМИНА на свою почту:
-- update public.profiles
-- set role = 'admin'
-- where lower(email) = lower('EMAIL_АДМИНА');
