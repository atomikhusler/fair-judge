-- ═══════════════════════════════════════════════════════════════════
-- EPIC 16.4.0 — Admin Console Delete, Clear & Org Warning Utilities
-- ═══════════════════════════════════════════════════════════════════
-- Additive-only SECURITY DEFINER RPCs gated by public.is_platform_admin().
-- Safe to re-run (CREATE OR REPLACE FUNCTION + explicit REVOKE / GRANT).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Delete a single security alert event
create or replace function public.admin_delete_security_event(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_kind text;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  delete from public.security_events
  where id = p_id
  returning org_id, kind into v_org_id, v_kind;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'delete_security_event',
    v_org_id,
    jsonb_build_object('id', p_id, 'kind', v_kind)
  );

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

revoke all on function public.admin_delete_security_event(bigint) from public, anon;
grant execute on function public.admin_delete_security_event(bigint) to authenticated;

-- 2. Clear expired or all security alert events
create or replace function public.admin_clear_security_events(p_mode text default 'expired')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_mode text := lower(btrim(coalesce(p_mode, 'expired')));
  v_count int := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  if v_mode not in ('expired', 'all') then
    return jsonb_build_object('ok', false, 'error', 'invalid_mode');
  end if;

  if v_mode = 'all' then
    delete from public.security_events;
    get diagnostics v_count = row_count;
  else
    delete from public.security_events se
    where not exists (
      select 1
      from public.org_login_throttle t
      where t.locked_until > now()
        and t.key = lower(coalesce(se.org_id, ''))
    );
    get diagnostics v_count = row_count;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'clear_security_events',
    null,
    jsonb_build_object('mode', v_mode, 'deleted_count', v_count)
  );

  return jsonb_build_object('ok', true, 'mode', v_mode, 'deleted_count', v_count);
end;
$$;

revoke all on function public.admin_clear_security_events(text) from public, anon;
grant execute on function public.admin_clear_security_events(text) to authenticated;

-- 3. Delete a single support report from Inbox
create or replace function public.admin_delete_report(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_role text;
  v_status text;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  delete from public.support_reports
  where id = p_id
  returning org_id, role, status into v_org_id, v_role, v_status;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'delete_report',
    v_org_id,
    jsonb_build_object('id', p_id, 'role', v_role, 'status', v_status)
  );

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

revoke all on function public.admin_delete_report(uuid) from public, anon;
grant execute on function public.admin_delete_report(uuid) to authenticated;

-- 4. Clear all resolved support reports from Inbox
create or replace function public.admin_clear_resolved_reports()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  delete from public.support_reports
  where status = 'resolved';
  get diagnostics v_count = row_count;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'clear_resolved_reports',
    null,
    jsonb_build_object('deleted_count', v_count)
  );

  return jsonb_build_object('ok', true, 'deleted_count', v_count);
end;
$$;

revoke all on function public.admin_clear_resolved_reports() from public, anon;
grant execute on function public.admin_clear_resolved_reports() to authenticated;

-- 5. Permanently delete an announcement or org warning
create or replace function public.admin_delete_announcement(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_title text;
  v_audience text;
  v_target_org_id text;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  delete from public.announcements
  where id = p_id
  returning title, audience, target_org_id into v_title, v_audience, v_target_org_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'delete_announcement',
    v_target_org_id,
    jsonb_build_object('id', p_id, 'title', v_title, 'audience', v_audience)
  );

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

revoke all on function public.admin_delete_announcement(uuid) from public, anon;
grant execute on function public.admin_delete_announcement(uuid) to authenticated;

-- 6. Clear ended or expired announcements
create or replace function public.admin_clear_ended_announcements()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  delete from public.announcements
  where active = false
     or (ends_at is not null and ends_at <= now());
  get diagnostics v_count = row_count;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'clear_ended_announcements',
    null,
    jsonb_build_object('deleted_count', v_count)
  );

  return jsonb_build_object('ok', true, 'deleted_count', v_count);
end;
$$;

revoke all on function public.admin_clear_ended_announcements() from public, anon;
grant execute on function public.admin_clear_ended_announcements() to authenticated;

-- 7. List warnings / notices targeting a specific organization
create or replace function public.admin_list_org_announcements(p_org_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text := upper(btrim(coalesce(p_org_id, '')));
  v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  if v_org_id = '' then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.active desc, a.created_at desc), '[]'::jsonb)
  into v_result
  from public.announcements a
  where a.audience = 'org'
    and upper(coalesce(a.target_org_id, '')) = v_org_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_org_announcements(text) from public, anon;
grant execute on function public.admin_list_org_announcements(text) to authenticated;
