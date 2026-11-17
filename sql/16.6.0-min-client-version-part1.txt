-- ═══════════════════════════════════════════════════════════════════
-- EPIC 16.6.0 — Minimum Client Version Safety Net (Optional Rollout Guard)
-- ═══════════════════════════════════════════════════════════════════
-- Additive, upgrade-safe migration:
-- 1. Creates public.app_settings (key text primary key, value text) with
--    RLS enabled and ZERO anon/authenticated grants on the table.
-- 2. Seeds ('min_client_version', '0.0.0') only if missing (blocks nothing).
-- 3. Creates public.fj_min_client_version() returning text, SECURITY DEFINER,
--    fixed search_path, granted to anon and authenticated.
-- 4. Leaves public.fj_health() untouched.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists public.app_settings (
  key text primary key,
  value text not null
);

alter table public.app_settings enable row level security;

-- Lock down direct table access from client roles completely
revoke all on table public.app_settings from public;
revoke all on table public.app_settings from anon;
revoke all on table public.app_settings from authenticated;

-- Seed default minimum version only if absent (never overwrites an existing policy)
insert into public.app_settings (key, value)
values ('min_client_version', '0.0.0')
on conflict (key) do nothing;

-- Narrow read-only RPC returning only min_client_version
create or replace function public.fj_min_client_version()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select value from public.app_settings where key = 'min_client_version' limit 1),
    '0.0.0'
  );
$$;

revoke all on function public.fj_min_client_version() from public;
grant execute on function public.fj_min_client_version() to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION QUERY (Read-only, returns ONE jsonb cell)
-- ═══════════════════════════════════════════════════════════════════
select jsonb_build_object(
  'epic_16_6_0_min_client_version', 'verified',
  'table_exists', to_regclass('public.app_settings') is not null,
  'rls_enabled', coalesce(
    (
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'app_settings'
    ),
    false
  ),
  'client_table_grants', (
    select count(*)
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'app_settings'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  ),
  'default_min_client_version', (
    select value from public.app_settings where key = 'min_client_version'
  ),
  'rpc_signature_ok', to_regprocedure('public.fj_min_client_version()') is not null,
  'rpc_execute_grants', (
    select array_agg(grantee::text order by grantee::text)
    from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'fj_min_client_version'
      and privilege_type = 'EXECUTE'
      and grantee in ('anon', 'authenticated')
  ),
  'fj_min_client_version_result', public.fj_min_client_version()
);
