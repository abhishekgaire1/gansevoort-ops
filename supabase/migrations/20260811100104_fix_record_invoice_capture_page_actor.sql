-- Bug fix: record_invoice_capture_page (20260811100103) selected v_session
-- without created_by_app_user_id, but its own RECEIVED audit-event insert
-- referenced v_session.created_by_app_user_id -- every real call failed
-- with Postgres error 42703 ("record v_session has no field
-- created_by_app_user_id"), so no capture session could ever reach
-- RECEIVED. No mocked unit test could catch this (a mocked supabase.rpc()
-- never parses real PL/pgSQL); it surfaced during a live end-to-end smoke
-- test of the phone-capture Edge Function against the real database. Pure
-- bug fix -- same signature, same behavior otherwise, no schema change.
create or replace function public.record_invoice_capture_page(
  p_token_digest text,
  p_page_number integer,
  p_storage_path text,
  p_content_type text,
  p_byte_size integer,
  p_content_hash text
)
returns table (out_session_id uuid, out_already_recorded boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_existing_id uuid;
begin
  select id, organization_id, status, expires_at, created_by_app_user_id into v_session
    from public.invoice_capture_sessions
   where token_digest = p_token_digest;

  if not found then
    raise exception 'capture session not found' using errcode = 'GA059';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'capture session expired' using errcode = 'GA060';
  end if;

  select id into v_existing_id
    from public.invoice_capture_pages
   where capture_session_id = v_session.id and page_number = p_page_number;

  if found then
    -- Idempotent replay of an already-recorded page -- never a duplicate
    -- row, never a second RECEIVED transition/audit event.
    return query select v_session.id, true;
    return;
  end if;

  if v_session.status <> 'WAITING' then
    raise exception 'capture session is not accepting uploads (status %)', v_session.status using errcode = 'GA061';
  end if;

  insert into public.invoice_capture_pages (organization_id, capture_session_id, page_number, storage_path, content_type, byte_size, content_hash)
  values (v_session.organization_id, v_session.id, p_page_number, p_storage_path, p_content_type, p_byte_size, p_content_hash);

  update public.invoice_capture_sessions
     set status = 'RECEIVED', received_at = now()
   where id = v_session.id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (v_session.organization_id, v_session.created_by_app_user_id, 'PHONE_CAPTURE_RECEIVED', 'invoice_capture_session', v_session.id, jsonb_build_object('pageNumber', p_page_number, 'byteSize', p_byte_size));

  return query select v_session.id, false;
end;
$$;

revoke all on function public.record_invoice_capture_page(text, integer, text, text, integer, text) from public;
grant execute on function public.record_invoice_capture_page(text, integer, text, text, integer, text) to service_role;
