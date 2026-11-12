-- EPIC 15.7 STAGE A: Clock Check Server Function
-- Allows cross-origin client to determine precise server time offset without relying on CORS-blocked Date headers.

create or replace function public.fj_server_time()
returns timestamptz
language sql
stable
as 'select now()';

revoke all on function public.fj_server_time() from public;
grant execute on function public.fj_server_time() to anon, authenticated;
