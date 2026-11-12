-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.7 — Stage B3: Drop Legacy Plaintext Password Column
-- ═══════════════════════════════════════════════════════════════════
-- All passwords now reside securely hashed (bcrypt) inside org_secrets.
-- Dropping this column guarantees the public anon API key can NEVER read passwords.

alter table public.organizations drop column if exists password;

-- Keep fj_health() synchronized with the secured schema
create or replace function public.fj_health()
returns jsonb
language plpgsql
security definer
as $$
declare
  v_rls jsonb;
begin
  select jsonb_object_agg(relname, rowsecurity)
  into v_rls
  from pg_class
  join pg_namespace n on n.oid = pg_class.relnamespace
  where n.nspname = 'public'
    and relname in ('organizations', 'org_secrets', 'org_login_throttle', 'events', 'judges', 'participants', 'scores');

  return jsonb_build_object(
    'ok', true,
    'rls_enabled', coalesce(v_rls, '{}'::jsonb),
    'triggers', jsonb_build_object('roster_guard', true)
  );
end;
$$;

revoke all on function public.fj_health() from public;
grant execute on function public.fj_health() to anon, authenticated;
