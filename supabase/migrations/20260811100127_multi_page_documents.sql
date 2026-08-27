-- Multi-page phone capture + document support.
--
-- Approved product decision: the phone capture workflow (and, more
-- generally, an uploaded document) must support invoices/documents made of
-- several photos/pages, submitted and processed as ONE document, never as
-- separate documents. This migration is additive/forward-only -- 100001-
-- 100126 are already applied and are not edited.
--
-- What already existed (verified by direct inspection before writing this
-- migration):
--   - `documents` (20260811100018): exactly one file per row
--     (storage_path/content_type/byte_size/file_sha256), fully append-only.
--     finalize_document_upload (20260811100024) is the ONLY inserter.
--   - `invoice_capture_pages` (20260811100103): already a child table
--     keyed by (capture_session_id, page_number), explicitly designed "so
--     V1's one-page capture never needs a schema rewrite if multi-page
--     capture is added later" -- but begin_invoice_capture_upload hard-
--     rejected any p_page_number <> 1 (GA061), and the session model only
--     ever recorded one page.
--
-- What this migration adds:
--   1. document_pages -- the durable, immutable, per-DOCUMENT page record
--      (mirrors `documents`' own append-only pattern exactly). A new
--      AFTER INSERT trigger on `documents` automatically creates that
--      document's own page-1 row from the SAME columns finalize_document_
--      upload already writes -- so finalize_document_upload itself needs
--      NO changes at all, and every existing single-page document keeps
--      working unmodified. Existing rows are backfilled the same way.
--   2. add_document_page -- the only way a page 2+ is ever added to an
--      already-finalized document, once its bytes are durably in Storage.
--      Strictly sequential (no gaps), capped at MAX_DOCUMENT_PAGES,
--      idempotent on retry (matching finalize_document_upload's own
--      replay-on-identity-match pattern), audit-logged.
--   3. invoice_capture_pages/sessions relaxed for genuine multi-page
--      staging: begin_invoice_capture_upload and record_invoice_capture_
--      page now accept any strictly-sequential next page number (not just
--      1) while the session is WAITING or RECEIVED. New delete_invoice_
--      capture_page (retake/delete, renumbering the rest) and reorder_
--      invoice_capture_pages (drag-reorder) RPCs make invoice_capture_pages
--      genuinely mutable pre-submission staging material -- unlike
--      document_pages, which stays fully immutable once a document is
--      finalized. This requires DROPPING invoice_capture_pages' own
--      forbid_update/forbid_delete triggers (added in 100103): RLS is
--      still deny-by-default and every mutation still only ever happens
--      through one of these narrow, token-authorized RPCs -- nothing
--      about the authorization model changes, only which SQL operations
--      the table itself permits.
--   4. get_invoice_capture_session_phone gains an out_page_count column
--      (dropped and recreated -- Postgres cannot change a function's
--      RETURNS TABLE shape via a bare CREATE OR REPLACE) so the phone
--      shell can recover "how many pages already exist" after an
--      accidental reload, and list_invoice_capture_pages_desktop lets the
--      desktop bridge enumerate every captured page (not just page 1) to
--      feed them all into the real upload pipeline in order.
--
-- Page limit: MAX_DOCUMENT_PAGES = 20, chosen from this codebase's own
-- existing constraints -- MAX_FILE_BYTES is already 20MB per single image/
-- PDF (documentUpload.ts), Gemini structured-output extraction already
-- runs as one multi-part call per document (no per-page cost multiplier
-- beyond the images themselves), and real vendor invoices/receipts this
-- platform processes are essentially never more than a handful of pages --
-- 20 is generous headroom while keeping a single extraction call's total
-- payload and worst-case latency bounded.

-- ============================================================
-- 1. document_pages -- durable, immutable, one row per page of a
--    finalized document.
-- ============================================================
create table public.document_pages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  document_id uuid not null,
  page_number integer not null,
  storage_path text not null,
  content_type text not null,
  byte_size bigint not null,
  file_sha256 text not null,
  created_at timestamptz not null default now(),
  constraint document_pages_page_number_check check (page_number > 0 and page_number <= 20),
  constraint document_pages_content_type_check check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  constraint document_pages_byte_size_check check (byte_size > 0),
  constraint document_pages_sha256_check check (char_length(file_sha256) = 64),
  constraint document_pages_document_org_fk foreign key (document_id, organization_id)
    references public.documents (id, organization_id)
);

create unique index document_pages_document_page_key
  on public.document_pages (document_id, page_number);

-- Mirrors documents_org_storage_path_key -- each page's Storage object is
-- unique per organization by construction (a fresh document id + page
-- number embedded in the path).
create unique index document_pages_org_storage_path_key
  on public.document_pages (organization_id, storage_path);

create index document_pages_org_created_at_idx
  on public.document_pages (organization_id, created_at desc);

create trigger document_pages_forbid_update
  before update on public.document_pages
  for each row execute function public.forbid_update_delete();
create trigger document_pages_forbid_delete
  before delete on public.document_pages
  for each row execute function public.forbid_update_delete();

alter table public.document_pages enable row level security;
-- Deny-by-default: no policies for anon/authenticated -- same as every
-- other table in this pipeline.

-- ============================================================
-- 2. Every documents row automatically gets its own page-1 document_pages
--    row -- finalize_document_upload (100024) needs NO changes at all.
-- ============================================================
create or replace function public.create_document_page_one()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.document_pages (organization_id, document_id, page_number, storage_path, content_type, byte_size, file_sha256, created_at)
  values (new.organization_id, new.id, 1, new.storage_path, new.content_type, new.byte_size, new.file_sha256, new.created_at);
  return new;
end;
$$;

create trigger documents_create_page_one
  after insert on public.documents
  for each row execute function public.create_document_page_one();

-- Backfill every existing document -- idempotent (safe to rerun): only
-- inserts a page-1 row where one doesn't already exist.
insert into public.document_pages (organization_id, document_id, page_number, storage_path, content_type, byte_size, file_sha256, created_at)
select d.organization_id, d.id, 1, d.storage_path, d.content_type, d.byte_size, d.file_sha256, d.created_at
  from public.documents d
 where not exists (
   select 1 from public.document_pages p where p.document_id = d.id and p.page_number = 1
 );

-- ============================================================
-- 3. add_document_page -- the only way page 2+ is added to an already-
--    finalized document. GA069 sequence/limit violation, GA070 identity
--    conflict on replay (mirrors finalize_document_upload's GA001).
-- ============================================================
create or replace function public.add_document_page(
  p_organization_id uuid,
  p_document_id uuid,
  p_app_user_id uuid,
  p_page_number integer,
  p_storage_path text,
  p_content_type text,
  p_byte_size bigint,
  p_file_sha256 text
)
returns table (out_page_id uuid, out_replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_current_max integer;
  v_page_id uuid;
begin
  if not exists (select 1 from public.documents where id = p_document_id and organization_id = p_organization_id) then
    raise exception 'document % not found in organization %', p_document_id, p_organization_id;
  end if;

  if p_page_number <= 0 or p_page_number > 20 then
    raise exception 'a document may have at most 20 pages' using errcode = 'GA069';
  end if;

  select id, storage_path, content_type, byte_size, file_sha256 into v_existing
    from public.document_pages
   where document_id = p_document_id and page_number = p_page_number;

  if found then
    if v_existing.storage_path is distinct from p_storage_path
       or v_existing.content_type is distinct from p_content_type
       or v_existing.byte_size is distinct from p_byte_size
       or v_existing.file_sha256 is distinct from p_file_sha256
    then
      raise exception 'document % page % already exists with different file identity', p_document_id, p_page_number
        using errcode = 'GA070';
    end if;
    return query select v_existing.id, true;
    return;
  end if;

  select coalesce(max(page_number), 0) into v_current_max
    from public.document_pages
   where document_id = p_document_id;

  if p_page_number <> v_current_max + 1 then
    raise exception 'document % page % must be added in sequence (next expected page: %)', p_document_id, p_page_number, v_current_max + 1
      using errcode = 'GA069';
  end if;

  insert into public.document_pages (organization_id, document_id, page_number, storage_path, content_type, byte_size, file_sha256)
  values (p_organization_id, p_document_id, p_page_number, p_storage_path, p_content_type, p_byte_size, p_file_sha256)
  returning id into v_page_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'DOCUMENT_PAGE_ADDED', 'document', p_document_id, jsonb_build_object('pageNumber', p_page_number, 'pageId', v_page_id));

  return query select v_page_id, false;
end;
$$;

revoke all on function public.add_document_page(uuid, uuid, uuid, integer, text, text, bigint, text) from public;
grant execute on function public.add_document_page(uuid, uuid, uuid, integer, text, text, bigint, text) to service_role;

-- ============================================================
-- 4. list_document_pages -- ordered read for the desktop review UI
--    (organization-scoped; never trusts a client-supplied organization_id
--    without this filter, same as every other read in this pipeline).
-- ============================================================
create or replace function public.list_document_pages(
  p_organization_id uuid,
  p_document_id uuid
)
returns table (out_page_number integer, out_storage_path text, out_content_type text)
language sql
stable
security definer
set search_path = ''
as $$
  select page_number, storage_path, content_type
    from public.document_pages
   where organization_id = p_organization_id and document_id = p_document_id
   order by page_number;
$$;

revoke all on function public.list_document_pages(uuid, uuid) from public;
grant execute on function public.list_document_pages(uuid, uuid) to service_role;

-- ============================================================
-- 5. invoice_capture_pages -- relax from single-page-only to genuine
--    multi-page staging.
-- ============================================================

-- 100103 made this table fully append-only (no legitimate reason to
-- delete/replace THE one page in single-page V1 -- you'd cancel the whole
-- session instead). Multi-page needs real delete (retake, remove a page)
-- and in-place renumber (delete-renumber, reorder) -- both are now only
-- ever performed by the narrow, token-authorized RPCs below; RLS is still
-- deny-by-default and no client of any kind ever gets a raw table
-- reference, so dropping these triggers does not widen who can mutate
-- this data, only what the already-sole mutation path (the RPC layer) is
-- permitted to do.
drop trigger if exists invoice_capture_pages_forbid_update on public.invoice_capture_pages;
drop trigger if exists invoice_capture_pages_forbid_delete on public.invoice_capture_pages;

create or replace function public.begin_invoice_capture_upload(
  p_token_digest text,
  p_page_number integer
)
returns table (out_session_id uuid, out_organization_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_current_max integer;
begin
  select id, organization_id, status, expires_at into v_session
    from public.invoice_capture_sessions
   where token_digest = p_token_digest;

  if not found then
    raise exception 'capture session not found' using errcode = 'GA059';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'capture session expired' using errcode = 'GA060';
  end if;
  -- Multi-page (100127): a session accepts uploads while WAITING (no
  -- pages yet) or RECEIVED (at least one page already recorded) -- only a
  -- CANCELLED or CONTINUED session refuses further uploads.
  if v_session.status not in ('WAITING', 'RECEIVED') then
    raise exception 'capture session is not accepting uploads (status %)', v_session.status using errcode = 'GA061';
  end if;

  select coalesce(max(page_number), 0) into v_current_max
    from public.invoice_capture_pages
   where capture_session_id = v_session.id;

  if p_page_number > 20 then
    raise exception 'a capture session may have at most 20 pages' using errcode = 'GA061';
  end if;
  if p_page_number <> v_current_max + 1 then
    raise exception 'page % must be the next sequential page (expected %)', p_page_number, v_current_max + 1 using errcode = 'GA061';
  end if;

  return query select v_session.id, v_session.organization_id;
end;
$$;

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
  select id, organization_id, status, expires_at into v_session
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

-- Retake/remove a page (Part: mobile capture Delete/Retake) -- only while
-- the session is still open for editing (WAITING/RECEIVED, i.e. never
-- CONTINUED after the desktop already finalized a document from it, and
-- never CANCELLED). Renumbers subsequent pages down by one so numbering
-- stays contiguous 1..N; a negative-offset temp renumber avoids the
-- (capture_session_id, page_number) unique index colliding mid-shift.
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
  select id, organization_id, status, expires_at into v_session
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

-- Reorder pages (Part: mobile capture reordering). p_new_page_order is the
-- CURRENT page numbers listed in their NEW desired order -- must be
-- exactly a permutation of 1..N for this session's existing page count.
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
  select id, organization_id, status, expires_at into v_session
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

revoke all on function public.delete_invoice_capture_page(text, integer) from public;
grant execute on function public.delete_invoice_capture_page(text, integer) to service_role;
revoke all on function public.reorder_invoice_capture_pages(text, integer[]) from public;
grant execute on function public.reorder_invoice_capture_pages(text, integer[]) to service_role;

-- ============================================================
-- 6. get_invoice_capture_session_phone -- add out_page_count so the phone
--    shell can recover "how many pages already exist" after a reload.
--    Dropped and recreated: Postgres cannot change a function's RETURNS
--    TABLE shape via a bare CREATE OR REPLACE.
-- ============================================================
drop function if exists public.get_invoice_capture_session_phone(text);

create function public.get_invoice_capture_session_phone(
  p_token_digest text
)
returns table (
  out_session_id uuid,
  out_status text,
  out_expires_at timestamptz,
  out_page_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    case when s.status = 'WAITING' and s.expires_at <= now() then 'EXPIRED' else s.status end,
    s.expires_at,
    (select count(*)::integer from public.invoice_capture_pages p where p.capture_session_id = s.id)
  from public.invoice_capture_sessions s
 where s.token_digest = p_token_digest;
$$;

revoke all on function public.get_invoice_capture_session_phone(text) from public;
grant execute on function public.get_invoice_capture_session_phone(text) to service_role;

-- ============================================================
-- 7. list_invoice_capture_pages_desktop -- desktop-authenticated ordered
--    read of every page a session has received, so the desktop bridge can
--    feed all of them into the real upload pipeline in order (not just
--    page 1).
-- ============================================================
create or replace function public.list_invoice_capture_pages_desktop(
  p_organization_id uuid,
  p_session_id uuid
)
returns table (out_page_number integer, out_storage_path text, out_content_type text, out_byte_size integer)
language sql
stable
security definer
set search_path = ''
as $$
  select page_number, storage_path, content_type, byte_size
    from public.invoice_capture_pages
   where organization_id = p_organization_id and capture_session_id = p_session_id
   order by page_number;
$$;

revoke all on function public.list_invoice_capture_pages_desktop(uuid, uuid) from public;
grant execute on function public.list_invoice_capture_pages_desktop(uuid, uuid) to service_role;

-- ============================================================
-- 8. New app-defined SQLSTATEs, continuing the project-wide GA0xx
--    sequence (highest in use before this migration: GA068).
-- ============================================================
-- GA069 DOCUMENT_PAGE_SEQUENCE_OR_LIMIT (add_document_page: out-of-
--   sequence page number, or the 20-page cap exceeded)
-- GA070 DOCUMENT_PAGE_IDENTITY_CONFLICT (add_document_page: a replay
--   whose identity doesn't match the existing page -- mirrors GA001)
-- GA072 CAPTURE_PAGE_NOT_FOUND_OR_INVALID_REORDER (delete/reorder
--   referencing a page number that doesn't exist, or a malformed
--   permutation)
