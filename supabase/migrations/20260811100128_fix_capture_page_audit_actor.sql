-- Fixes a real bug in 20260811100127: record_invoice_capture_page,
-- delete_invoice_capture_page, and reorder_invoice_capture_pages each
-- write an audit_events row referencing v_session.created_by_app_user_id,
-- but their own `select ... into v_session` never selected that column --
-- every call to any of the three raised "record v_session has no field
-- created_by_app_user_id" before ever reaching the audit insert (caught by
-- direct RPC smoke-testing against DEV immediately after 100127 was
-- applied). 100127 is already applied and is not edited; this is a
-- forward-only, body-only fix (same signatures, exact-copy-then-patched
-- from 100127's own text -- the only change in each function is adding
-- created_by_app_user_id to the v_session select list).

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
  select id, organization_id, created_by_app_user_id, status, expires_at into v_session
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

  if v_session.status not in ('WAITING', 'RECEIVED') then
    raise exception 'capture session is not accepting uploads (status %)', v_session.status using errcode = 'GA061';
  end if;

  insert into public.invoice_capture_pages (organization_id, capture_session_id, page_number, storage_path, content_type, byte_size, content_hash)
  values (v_session.organization_id, v_session.id, p_page_number, p_storage_path, p_content_type, p_byte_size, p_content_hash);

  update public.invoice_capture_sessions
     set status = 'RECEIVED', received_at = coalesce(received_at, now())
   where id = v_session.id and status <> 'RECEIVED';

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (v_session.organization_id, v_session.created_by_app_user_id, 'PHONE_CAPTURE_RECEIVED', 'invoice_capture_session', v_session.id, jsonb_build_object('pageNumber', p_page_number, 'byteSize', p_byte_size));

  return query select v_session.id, false;
end;
$$;

create or replace function public.delete_invoice_capture_page(
  p_token_digest text,
  p_page_number integer
)
returns table (out_session_id uuid, out_remaining_page_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_page_id uuid;
  v_remaining integer;
begin
  select id, organization_id, created_by_app_user_id, status, expires_at into v_session
    from public.invoice_capture_sessions
   where token_digest = p_token_digest;

  if not found then
    raise exception 'capture session not found' using errcode = 'GA059';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'capture session expired' using errcode = 'GA060';
  end if;
  if v_session.status not in ('WAITING', 'RECEIVED') then
    raise exception 'capture session is not open for editing (status %)', v_session.status using errcode = 'GA061';
  end if;

  select id into v_page_id
    from public.invoice_capture_pages
   where capture_session_id = v_session.id and page_number = p_page_number;

  if not found then
    raise exception 'page % not found for this capture session', p_page_number using errcode = 'GA072';
  end if;

  delete from public.invoice_capture_pages where id = v_page_id;

  update public.invoice_capture_pages
     set page_number = -page_number
   where capture_session_id = v_session.id and page_number > p_page_number;
  update public.invoice_capture_pages
     set page_number = -page_number - 1
   where capture_session_id = v_session.id and page_number < 0;

  select count(*) into v_remaining from public.invoice_capture_pages where capture_session_id = v_session.id;

  if v_remaining = 0 then
    -- No pages left: back to accepting a first page.
    update public.invoice_capture_sessions set status = 'WAITING', received_at = null where id = v_session.id;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (v_session.organization_id, v_session.created_by_app_user_id, 'PHONE_CAPTURE_PAGE_DELETED', 'invoice_capture_session', v_session.id, jsonb_build_object('deletedPageNumber', p_page_number, 'remainingPages', v_remaining));

  return query select v_session.id, v_remaining;
end;
$$;

create or replace function public.reorder_invoice_capture_pages(
  p_token_digest text,
  p_new_page_order integer[]
)
returns table (out_session_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_expected_count integer;
  v_count integer;
  v_page_number integer;
  v_position integer;
begin
  select id, organization_id, created_by_app_user_id, status, expires_at into v_session
    from public.invoice_capture_sessions
   where token_digest = p_token_digest;

  if not found then
    raise exception 'capture session not found' using errcode = 'GA059';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'capture session expired' using errcode = 'GA060';
  end if;
  if v_session.status not in ('WAITING', 'RECEIVED') then
    raise exception 'capture session is not open for editing (status %)', v_session.status using errcode = 'GA061';
  end if;

  select count(*) into v_expected_count from public.invoice_capture_pages where capture_session_id = v_session.id;
  v_count := coalesce(array_length(p_new_page_order, 1), 0);
  if v_count <> v_expected_count then
    raise exception 'reorder must include exactly the % existing page(s)', v_expected_count using errcode = 'GA072';
  end if;
  if (select count(distinct x) from unnest(p_new_page_order) as x) <> v_count
     or exists (select 1 from unnest(p_new_page_order) as x where x < 1 or x > v_expected_count)
  then
    raise exception 'reorder must be a permutation of the existing page numbers 1..%', v_expected_count using errcode = 'GA072';
  end if;

  update public.invoice_capture_pages set page_number = -page_number where capture_session_id = v_session.id;

  for v_position in 1 .. v_count loop
    v_page_number := p_new_page_order[v_position];
    update public.invoice_capture_pages
       set page_number = v_position
     where capture_session_id = v_session.id and page_number = -v_page_number;
  end loop;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (v_session.organization_id, v_session.created_by_app_user_id, 'PHONE_CAPTURE_PAGES_REORDERED', 'invoice_capture_session', v_session.id, jsonb_build_object('newOrder', p_new_page_order));

  return query select v_session.id;
end;
$$;
