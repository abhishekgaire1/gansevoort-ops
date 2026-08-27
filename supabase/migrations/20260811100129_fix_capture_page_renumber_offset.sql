-- Fixes a second real bug in 20260811100127 (carried into 100128's
-- otherwise-unrelated fix): delete_invoice_capture_page and
-- reorder_invoice_capture_pages both renumbered pages via a temporary
-- NEGATIVE page_number to dodge the (capture_session_id, page_number)
-- unique index mid-shift. invoice_capture_pages_page_number_check is
-- `check (page_number > 0)`, and Postgres evaluates CHECK constraints
-- immediately per statement -- unlike UNIQUE/FK constraints, they are
-- never DEFERRABLE -- so the very first negative-valued UPDATE raised a
-- constraint violation before the second UPDATE ever ran (caught by
-- direct RPC smoke-testing against DEV immediately after 100128 was
-- applied). 100127/100128 are already applied and are not edited; this is
-- a forward-only, body-only fix (same signatures, exact-copy-then-patched
-- from 100128's own text): both functions now use a +1000 positive
-- offset instead of a negated one -- safely outside the 1..20 page range
-- this table's own check constraint already enforces, so it can never
-- collide with a real page number mid-shift, and it never goes negative.

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
     set page_number = page_number + 1000
   where capture_session_id = v_session.id and page_number > p_page_number;
  update public.invoice_capture_pages
     set page_number = page_number - 1001
   where capture_session_id = v_session.id and page_number > 1000;

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

  update public.invoice_capture_pages set page_number = page_number + 1000 where capture_session_id = v_session.id;

  for v_position in 1 .. v_count loop
    v_page_number := p_new_page_order[v_position];
    update public.invoice_capture_pages
       set page_number = v_position
     where capture_session_id = v_session.id and page_number = v_page_number + 1000;
  end loop;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (v_session.organization_id, v_session.created_by_app_user_id, 'PHONE_CAPTURE_PAGES_REORDERED', 'invoice_capture_session', v_session.id, jsonb_build_object('newOrder', p_new_page_order));

  return query select v_session.id;
end;
$$;
