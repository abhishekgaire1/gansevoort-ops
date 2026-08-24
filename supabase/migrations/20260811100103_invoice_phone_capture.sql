-- Phone-to-Desktop Invoice Capture milestone.
--
-- ============================================================
-- WHAT ALREADY EXISTED (verified by direct inspection before writing this
-- migration) -- this migration deliberately does NOT rebuild any of it:
-- ============================================================
-- The full source-document ingestion pipeline (private receiving-documents
-- Storage bucket, two-phase signed-upload-URL flow, magic-byte MIME
-- validation, SHA-256 exact-duplicate hashing, finalize_document_upload
-- RPC creating documents + the first document_extractions row atomically,
-- AI extraction scheduling) already exists and is exactly what Phone
-- Capture must feed into, unchanged -- see app/actions/documentUpload.ts,
-- app/lib/documents/finalizeDocumentUploadRpc.ts. A second, currently-
-- dormant "Scan Invoice" source (app/manager/(app)/receiving/_components/
-- ScanInvoiceFlow.tsx, deliberately paused/unwired per an earlier
-- milestone -- CLAUDE.md: "do not resume scanner work") already proves
-- the exact pattern this migration follows: capture happens into a
-- temporary, LOCAL client-side working set first; only once the Manager
-- reviews and clicks a confirm action does the material enter
-- initiateUpload/uploadAndFinalize, the SAME pipeline a manually-picked
-- file uses. Phone Capture mirrors that architecture, never a parallel
-- document-processing system.
--
-- What genuinely does not exist yet, and is what this migration adds:
--   1. invoice_capture_sessions -- a durable, token-authorized, short-lived
--      session record, created by an authenticated desktop Manager/Admin,
--      that an UNAUTHENTICATED phone browser can act against ONLY through
--      possession of an unguessable bearer token (never full app login).
--   2. invoice_capture_pages -- a child table (not a single overwritable
--      file column) so V1's one-page capture never needs a schema
--      rewrite if multi-page capture is added later (Part 14-15).
--   3. RPCs that are the ONLY way either side ever mutates this state --
--      the phone-facing TypeScript layer (a separate milestone concern)
--      never gets a raw Supabase client of any kind, only narrow Server
--      Actions that validate the token first and then use the SAME
--      service-role client every other action in this codebase uses.
--
-- Storage: reuses the EXISTING private receiving-documents bucket (no new
-- bucket -- none of this project's buckets are created via migration, and
-- adding a second one would be an undocumented manual Dashboard step this
-- migration can't itself perform) under a distinct
-- org/<org>/captures/<session>/ prefix, kept clearly separate from
-- org/<org>/documents/<document>/ so temporary capture evidence and
-- authoritative document evidence are never confusable by path alone.

-- ============================================================
-- 1. invoice_capture_sessions
-- ============================================================
-- Expiry is DERIVED at read time (expires_at < now()), never written by a
-- background job -- no scheduled-job infrastructure exists anywhere in
-- this project yet, and adding one solely for this would be
-- disproportionate (Part 61: "mark records terminal now and defer
-- physical cleanup job, but report it" -- physical row cleanup is
-- deferred; expiry SEMANTICS are enforced on every read/write regardless).
-- document_id is populated only once the SAME desktop-side
-- initiateUpload/uploadAndFinalize pipeline has already created the real
-- documents row -- continue_invoice_capture_session below is a pure
-- traceability/token-closing step, never itself a document-creation path.
create table public.invoice_capture_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  created_by_app_user_id uuid not null,
  document_id uuid,
  token_digest text not null,
  status text not null default 'WAITING',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  received_at timestamptz,
  cancelled_at timestamptz,
  continued_at timestamptz,
  constraint invoice_capture_sessions_id_org_key unique (id, organization_id),
  constraint invoice_capture_sessions_status_check check (status in ('WAITING', 'RECEIVED', 'CANCELLED', 'CONTINUED')),
  constraint invoice_capture_sessions_created_by_org_fk foreign key (created_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint invoice_capture_sessions_document_org_fk foreign key (document_id, organization_id)
    references public.documents (id, organization_id)
);

-- The token itself is never stored -- only its digest (Part 7). Unique so
-- a digest collision (astronomically unlikely for a properly random
-- token, but checked regardless) can never let one token resolve two
-- sessions.
create unique index invoice_capture_sessions_token_digest_key
  on public.invoice_capture_sessions (token_digest);

create index invoice_capture_sessions_org_status_idx
  on public.invoice_capture_sessions (organization_id, status);

-- Desktop refresh-recovery (Part 27): "does THIS manager currently have an
-- active capture session" is looked up by creator, not by a client-held
-- session id (which plain React state would lose on refresh).
create index invoice_capture_sessions_created_by_status_idx
  on public.invoice_capture_sessions (created_by_app_user_id, status);

-- Status transitions (WAITING -> RECEIVED -> CONTINUED, or -> CANCELLED)
-- are legitimate in-place updates, so only DELETE is blocked here --
-- unlike a fully append-only table, this is ephemeral session-
-- coordination bookkeeping, not itself historical business evidence (the
-- durable evidence is invoice_capture_pages below, and eventually the
-- documents row it gets promoted into) -- but it still must never be
-- silently destroyed.
create trigger invoice_capture_sessions_forbid_delete
  before delete on public.invoice_capture_sessions
  for each row execute function public.forbid_update_delete();

alter table public.invoice_capture_sessions enable row level security;
-- Deny-by-default: no policies for anon/authenticated. The phone browser
-- never receives a Supabase client capable of touching this table at
-- all -- every phone-facing operation is a Next.js Server Action that
-- validates the token server-side, then uses the service-role client.

-- ============================================================
-- 2. invoice_capture_pages -- child table, not a single overwritable
--    file column, so multi-page can be added later without a rewrite
--    (Part 15). Fully append-only: once a page's bytes are durably
--    recorded, its metadata never changes.
-- ============================================================
create table public.invoice_capture_pages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  capture_session_id uuid not null,
  page_number integer not null,
  storage_path text not null,
  content_type text not null,
  byte_size integer not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint invoice_capture_pages_page_number_check check (page_number > 0),
  constraint invoice_capture_pages_session_org_fk foreign key (capture_session_id, organization_id)
    references public.invoice_capture_sessions (id, organization_id)
);

-- Idempotency (Part 60/28): a retried "mark page received" call for the
-- SAME page number is a no-op, never a duplicate row.
create unique index invoice_capture_pages_session_page_key
  on public.invoice_capture_pages (capture_session_id, page_number);

create trigger invoice_capture_pages_forbid_update
  before update on public.invoice_capture_pages
  for each row execute function public.forbid_update_delete();
create trigger invoice_capture_pages_forbid_delete
  before delete on public.invoice_capture_pages
  for each row execute function public.forbid_update_delete();

alter table public.invoice_capture_pages enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 3. App-defined SQLSTATEs, continuing the project-wide GA0xx sequence
--    (highest in use before this migration: GA058).
-- ============================================================
-- GA059 CAPTURE_TOKEN_INVALID, GA060 CAPTURE_SESSION_EXPIRED,
-- GA061 CAPTURE_SESSION_NOT_AVAILABLE (cancelled, already received in
-- single-page V1, or already continued -- generically "not open for
-- upload right now")

-- ============================================================
-- 4. create_invoice_capture_session -- desktop-authenticated only (the
--    TypeScript action layer gates this on requireManagerOrAdmin()
--    before ever calling it; the RPC itself trusts its caller's
--    organization_id/actor exactly like every other authenticated
--    mutation in this schema).
-- ============================================================
create or replace function public.create_invoice_capture_session(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_token_digest text,
  p_expires_at timestamptz
)
returns table (out_session_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
begin
  insert into public.invoice_capture_sessions (organization_id, created_by_app_user_id, token_digest, status, expires_at)
  values (p_organization_id, p_actor_app_user_id, p_token_digest, 'WAITING', p_expires_at)
  returning id into v_session_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'PHONE_CAPTURE_SESSION_CREATED', 'invoice_capture_session', v_session_id, jsonb_build_object('expiresAt', p_expires_at));

  return query select v_session_id;
end;
$$;

revoke all on function public.create_invoice_capture_session(uuid, uuid, text, timestamptz) from public;
grant execute on function public.create_invoice_capture_session(uuid, uuid, text, timestamptz) to service_role;

-- ============================================================
-- 5. get_invoice_capture_session_desktop -- narrow desktop status read
--    (Part 65). Never returns token_digest. Effective status accounts for
--    derived expiry (a still-WAITING row past expires_at reads back as
--    EXPIRED here, without ever writing to the row).
-- ============================================================
create or replace function public.get_invoice_capture_session_desktop(
  p_organization_id uuid,
  p_session_id uuid
)
returns table (
  out_session_id uuid,
  out_status text,
  out_expires_at timestamptz,
  out_document_id uuid,
  out_page_count bigint
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
    s.document_id,
    (select count(*) from public.invoice_capture_pages p where p.capture_session_id = s.id)
  from public.invoice_capture_sessions s
 where s.id = p_session_id and s.organization_id = p_organization_id;
$$;

revoke all on function public.get_invoice_capture_session_desktop(uuid, uuid) from public;
grant execute on function public.get_invoice_capture_session_desktop(uuid, uuid) to service_role;

-- Refresh-recovery (Part 27): the most recent still-open session THIS
-- manager created, if any -- read at page-load so an accidental desktop
-- refresh can restore "Waiting for photo..."/"Photo received" without
-- relying on client-only React state.
create or replace function public.get_active_invoice_capture_session_for_manager(
  p_organization_id uuid,
  p_created_by_app_user_id uuid
)
returns table (
  out_session_id uuid,
  out_status text,
  out_expires_at timestamptz,
  out_document_id uuid,
  out_page_count bigint
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
    s.document_id,
    (select count(*) from public.invoice_capture_pages p where p.capture_session_id = s.id)
  from public.invoice_capture_sessions s
 where s.organization_id = p_organization_id
   and s.created_by_app_user_id = p_created_by_app_user_id
   and s.status in ('WAITING', 'RECEIVED')
 order by s.created_at desc
 limit 1;
$$;

revoke all on function public.get_active_invoice_capture_session_for_manager(uuid, uuid) from public;
grant execute on function public.get_active_invoice_capture_session_for_manager(uuid, uuid) to service_role;

-- ============================================================
-- 6. cancel_invoice_capture_session -- desktop-authenticated. No-op
--    (raises) if already terminal, so a stale "Cancel" click can never
--    silently reopen or misreport state.
-- ============================================================
create or replace function public.cancel_invoice_capture_session(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.invoice_capture_sessions
   where id = p_session_id and organization_id = p_organization_id;

  if not found then
    raise exception 'capture session % not found', p_session_id using errcode = 'GA059';
  end if;

  if v_status not in ('WAITING', 'RECEIVED') then
    -- Already cancelled/continued, or expired-but-still-WAITING (fine to
    -- cancel explicitly too) -- only a genuinely terminal non-WAITING/
    -- RECEIVED status is rejected.
    raise exception 'capture session % is already %', p_session_id, v_status using errcode = 'GA061';
  end if;

  update public.invoice_capture_sessions
     set status = 'CANCELLED', cancelled_at = now()
   where id = p_session_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_actor_app_user_id, 'PHONE_CAPTURE_CANCELLED', 'invoice_capture_session', p_session_id, jsonb_build_object('status', v_status), jsonb_build_object('status', 'CANCELLED'));
end;
$$;

revoke all on function public.cancel_invoice_capture_session(uuid, uuid, uuid) from public;
grant execute on function public.cancel_invoice_capture_session(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 7. continue_invoice_capture_session -- desktop-authenticated. Called
--    AFTER the desktop has already run the captured image through the
--    normal initiateUpload/uploadAndFinalize pipeline and a real
--    documents row exists -- this RPC never creates that row itself
--    (Part 23: "Do not duplicate these steps in the capture subsystem").
--    It closes the token (Part 29-30: no further uploads permitted) and
--    records which document the capture became, for traceability.
-- ============================================================
create or replace function public.continue_invoice_capture_session(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_session_id uuid,
  p_document_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.invoice_capture_sessions
   where id = p_session_id and organization_id = p_organization_id;

  if not found then
    raise exception 'capture session % not found', p_session_id using errcode = 'GA059';
  end if;

  if v_status <> 'RECEIVED' then
    raise exception 'capture session % is not ready to continue (status %)', p_session_id, v_status using errcode = 'GA061';
  end if;

  if not exists (select 1 from public.documents where id = p_document_id and organization_id = p_organization_id) then
    raise exception 'document % not found in organization %', p_document_id, p_organization_id;
  end if;

  update public.invoice_capture_sessions
     set status = 'CONTINUED', continued_at = now(), document_id = p_document_id
   where id = p_session_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'PHONE_CAPTURE_CONTINUED', 'invoice_capture_session', p_session_id, jsonb_build_object('documentId', p_document_id));
end;
$$;

revoke all on function public.continue_invoice_capture_session(uuid, uuid, uuid, uuid) from public;
grant execute on function public.continue_invoice_capture_session(uuid, uuid, uuid, uuid) to service_role;

-- ============================================================
-- 8. Phone-facing functions. Not gated by requireManagerOrAdmin() at the
--    TypeScript layer (the phone is never logged in) -- these are the
--    ONLY operations a valid token may perform (Part 30: "GET
--    capture-session display state, POST capture image, POST finish
--    capture. No generic authenticated API access"). Every one of them
--    takes p_token_digest, never a raw organization_id/session_id the
--    phone could substitute -- the session is resolved FROM the digest,
--    exactly the scoping the milestone requires (Part 32).
-- ============================================================

-- Phone status read (Part 66) -- narrow: valid/expired/cancelled/received
-- only, never business data.
create or replace function public.get_invoice_capture_session_phone(
  p_token_digest text
)
returns table (
  out_session_id uuid,
  out_status text,
  out_expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    case when s.status = 'WAITING' and s.expires_at <= now() then 'EXPIRED' else s.status end,
    s.expires_at
  from public.invoice_capture_sessions s
 where s.token_digest = p_token_digest;
$$;

revoke all on function public.get_invoice_capture_session_phone(text) from public;
grant execute on function public.get_invoice_capture_session_phone(text) to service_role;

-- Validates the token is currently WAITING and not expired, returning the
-- session's organization_id/id so the TypeScript layer can mint a signed
-- upload URL scoped to the exact expected staging object path -- never a
-- broader bucket grant (Part 31).
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
  -- Single-page V1 (Part 14): once a page exists at all, no further
  -- uploads are permitted through this session -- token closes after one
  -- accepted page. (Multi-page would relax this to "status = WAITING",
  -- unchanged otherwise -- see the migration's own header comment.)
  if v_session.status <> 'WAITING' then
    raise exception 'capture session is not accepting uploads (status %)', v_session.status using errcode = 'GA061';
  end if;
  if p_page_number <> 1 then
    raise exception 'only single-page capture is supported' using errcode = 'GA061';
  end if;

  return query select v_session.id, v_session.organization_id;
end;
$$;

revoke all on function public.begin_invoice_capture_upload(text, integer) from public;
grant execute on function public.begin_invoice_capture_upload(text, integer) to service_role;

-- Records a durably-uploaded page (Part 18/60): idempotent on
-- (capture_session_id, page_number) -- a retried "mark received" call
-- for the SAME page never inserts twice. Transitions the session
-- WAITING -> RECEIVED on first success only.
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
