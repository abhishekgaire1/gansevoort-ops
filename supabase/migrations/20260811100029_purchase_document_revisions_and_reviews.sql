-- Milestone 2A.2.1: verifier corrections, verified summary, and amendments.
--
-- Three additive capabilities on top of the existing purchase_documents
-- lifecycle, none of which change the state machine itself
-- (DRAFT -> READY_FOR_VERIFICATION -> VERIFIED, plus the READY -> DRAFT
-- reject path stay exactly as they were):
--
-- 1. An independent verifier may now correct fields/lines while
--    READY_FOR_VERIFICATION, instead of only Verify/Return-as-is. Every
--    meaningful reviewer save is individually, exactly attributed
--    (PURCHASE_DOCUMENT_REVIEW_CORRECTED, one event per save with a real
--    net change, actor = the actual saving manager) -- never batched,
--    never attributed to whoever happens to click Verify. Two distinct
--    counts exist: reviewEditCount (all attributable review activity in
--    the cycle) and finalCorrectionCount (the net submitted -> final
--    diff, which can be zero even if reviewEditCount isn't -- e.g. two
--    reviewers editing a field back and forth to its original value).
--
-- 2. Return-to-Draft now atomically restores business values from the
--    latest PURCHASE_DOCUMENT_SUBMITTED snapshot rather than leaving
--    whatever a reviewer had edited in place -- Verify means "I stand
--    behind these values," Return means "revert to what was actually
--    submitted, plus my note." Reviewer correction events remain in audit
--    history permanently either way.
--
-- 3. A VERIFIED purchase_document can be amended: a new revision, sharing
--    the same revision_group_id, is created (never mutating the verified
--    row it supersedes) and runs the exact same DRAFT -> READY -> VERIFIED
--    lifecycle independently. "Current verified revision" (authoritative
--    business truth) and "effective workflow revision" (open revision if
--    one exists, else current verified -- what the receiving queue shows)
--    are two distinct, never-conflated concepts throughout this schema.
--
-- Every new/changed identity check generalizes from documents.uploaded_by_
-- app_user_id to purchase_documents.created_by_app_user_id -- a no-op for
-- revision 1 (initialize_purchase_document_draft only ever sets
-- created_by_app_user_id to the already-verified uploader, so the two are
-- structurally guaranteed equal there), and the enabling change for
-- amendment revisions, whose preparer is whoever initiated the amendment,
-- not the original uploader.

-- ============================================================
-- 1. Stable line identity
-- ============================================================

-- Volatile default -> each existing row gets its OWN distinct value via a
-- full table rewrite that does NOT invoke row-level UPDATE triggers
-- (verified empirically against this exact Postgres/Supabase instance
-- before writing this migration: a throwaway temp table with a
-- BEFORE UPDATE trigger that unconditionally raises was given an
-- ADD COLUMN ... DEFAULT gen_random_uuid(), and the trigger never fired).
-- purchase_document_lines_forbid_when_locked is therefore never a concern
-- for this statement, on any existing row regardless of its parent's
-- status.
alter table public.purchase_document_lines
  add column line_key uuid not null default gen_random_uuid();

alter table public.purchase_document_lines
  add constraint purchase_document_lines_purchase_document_line_key_key
  unique (purchase_document_id, line_key);

-- ============================================================
-- 2. Revisions
-- ============================================================

-- Same reasoning as line_key above: ADD COLUMN with these defaults never
-- invokes purchase_documents_forbid_locked_mutation, so the real, existing
-- VERIFIED purchase_document in Gansevoort is backfilled without ever
-- touching its business columns or needing the freeze trigger disabled.
alter table public.purchase_documents
  add column revision_group_id uuid not null default gen_random_uuid(),
  add column revision_number integer not null default 1,
  add column previous_revision_id uuid,
  add column amendment_reason text;

alter table public.purchase_documents
  add constraint purchase_documents_revision_number_check check (revision_number > 0);

alter table public.purchase_documents
  add constraint purchase_documents_revision_sequence_check
  check ((revision_number = 1) = (previous_revision_id is null));

-- FK target for previous_revision_id below -- id alone is already unique,
-- so this is trivially satisfiable for every existing row.
alter table public.purchase_documents
  add constraint purchase_documents_id_org_group_source_key
  unique (id, organization_id, revision_group_id, source_document_id);

-- No duplicate revision numbers within a group (arbitrated by Postgres
-- even under a concurrent-amendment-initiation race).
alter table public.purchase_documents
  add constraint purchase_documents_org_group_revision_key
  unique (organization_id, revision_group_id, revision_number);

-- REQUIRED (not optional) same-org/same-group/same-source-document
-- guarantee: a previous_revision_id can only ever reference a row sharing
-- ALL THREE of organization_id, revision_group_id, and source_document_id
-- with the referencing row -- a cross-group or cross-source predecessor
-- link is impossible at the FK layer, not merely prevented by RPC care.
-- NULL on any FK column (true for every revision_number = 1 row, which
-- always has previous_revision_id null) skips the check entirely, which
-- is exactly correct: revision 1 has no predecessor to validate.
alter table public.purchase_documents
  add constraint purchase_documents_previous_revision_fk
  foreign key (previous_revision_id, organization_id, revision_group_id, source_document_id)
  references public.purchase_documents (id, organization_id, revision_group_id, source_document_id);

-- Replaces the old "at most one purchase_document per source_document"
-- rule, which cannot survive revisions (revision 1 and revision 2 share
-- the same source_document_id by design). The NEW invariant: at most one
-- revision_number = 1 row per source document. Every revision_group is
-- created by exactly one code path (initialize_purchase_document_draft,
-- which always creates revision 1) and every later revision is created by
-- initiate_purchase_document_amendment, which always copies revision_group_id
-- forward from the row being amended rather than generating a new one --
-- so "at most one revision-1 row per source document" transitively
-- guarantees "at most one revision family per source document," while
-- placing no limit on how many revision_number > 1 rows share that same
-- source_document_id.
alter table public.purchase_documents
  drop constraint purchase_documents_org_source_document_key;

create unique index purchase_documents_org_source_document_first_revision_key
  on public.purchase_documents (organization_id, source_document_id)
  where revision_number = 1;

-- At most one non-terminal (DRAFT/READY_FOR_VERIFICATION) revision open
-- per group at a time -- no forked/parallel amendment attempts.
create unique index purchase_documents_one_open_revision_per_group
  on public.purchase_documents (organization_id, revision_group_id)
  where status <> 'VERIFIED';

create index purchase_documents_revision_group_status_idx
  on public.purchase_documents (revision_group_id, status, revision_number desc);

-- The ONLY thing a future inventory/payment/AP consumer may ever treat as
-- authoritative business truth -- highest revision_number with
-- status = 'VERIFIED'. Distinct from, and never to be confused with, the
-- "effective workflow revision" the receiving queue surfaces (see
-- search_receiving_queue below), which may be an in-progress amendment
-- draft that has not (and might never) become verified.
create or replace function public.current_verified_purchase_document_revision_id(
  p_organization_id uuid,
  p_revision_group_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pd.id
    from public.purchase_documents pd
   where pd.organization_id = p_organization_id
     and pd.revision_group_id = p_revision_group_id
     and pd.status = 'VERIFIED'
   order by pd.revision_number desc
   limit 1;
$$;

revoke all on function public.current_verified_purchase_document_revision_id(uuid, uuid) from public;
grant execute on function public.current_verified_purchase_document_revision_id(uuid, uuid) to service_role;

-- ============================================================
-- 3. Shared diff helper -- one implementation, every caller
-- ============================================================

-- Structured field-level diff between two (header jsonb, lines jsonb)
-- snapshots, both always shaped exactly like a PURCHASE_DOCUMENT_SUBMITTED
-- snapshot's own fields (snake_case, header fields flat, lines correlated
-- by line_key -- never by array position, which breaks the instant a line
-- is added or removed anywhere but the end). Used identically by
-- save_purchase_document_review_corrections (old = state immediately
-- before this save, new = immediately after -- one attributed event per
-- save) and by verify_purchase_document (old = latest SUBMITTED snapshot,
-- new = state at verify -- a pure measurement, never an attributed event).
-- One implementation means the two counts this milestone cares about
-- (reviewEditCount, finalCorrectionCount) can never silently drift apart
-- in how they count a change.
create or replace function public.purchase_document_diff(
  p_old_header jsonb,
  p_old_lines jsonb,
  p_new_header jsonb,
  p_new_lines jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_header_changes jsonb := '[]'::jsonb;
  v_line_changes jsonb := '[]'::jsonb;
  v_field text;
  v_old_lines_by_key jsonb;
  v_new_lines_by_key jsonb;
  v_key text;
  v_old_line jsonb;
  v_new_line jsonb;
  v_line_field_changes jsonb;
  v_line_field text;
begin
  foreach v_field in array array[
    'vendor_id', 'document_type', 'document_number', 'document_date',
    'po_number', 'delivery_date', 'subtotal', 'tax', 'fees', 'total', 'currency'
  ]
  loop
    if (p_old_header -> v_field) is distinct from (p_new_header -> v_field) then
      v_header_changes := v_header_changes
        || jsonb_build_array(jsonb_build_object('field', v_field, 'before', p_old_header -> v_field, 'after', p_new_header -> v_field));
    end if;
  end loop;

  select coalesce(jsonb_object_agg(line -> 'value' ->> 'line_key', line -> 'value'), '{}'::jsonb) into v_old_lines_by_key
    from (select jsonb_array_elements(coalesce(p_old_lines, '[]'::jsonb)) as value) as line
   where line -> 'value' ->> 'line_key' is not null;

  select coalesce(jsonb_object_agg(line -> 'value' ->> 'line_key', line -> 'value'), '{}'::jsonb) into v_new_lines_by_key
    from (select jsonb_array_elements(coalesce(p_new_lines, '[]'::jsonb)) as value) as line
   where line -> 'value' ->> 'line_key' is not null;

  for v_key, v_old_line in select key, value from jsonb_each(v_old_lines_by_key)
  loop
    if not (v_new_lines_by_key ? v_key) then
      v_line_changes := v_line_changes || jsonb_build_array(jsonb_build_object('lineKey', v_key, 'kind', 'removed', 'line', v_old_line));
    end if;
  end loop;

  for v_key, v_new_line in select key, value from jsonb_each(v_new_lines_by_key)
  loop
    if not (v_old_lines_by_key ? v_key) then
      v_line_changes := v_line_changes || jsonb_build_array(jsonb_build_object('lineKey', v_key, 'kind', 'added', 'line', v_new_line));
    else
      v_old_line := v_old_lines_by_key -> v_key;
      v_line_field_changes := '[]'::jsonb;
      foreach v_line_field in array array[
        'vendor_sku', 'description', 'package_quantity', 'package_unit',
        'measured_quantity', 'measured_unit', 'unit_price', 'price_basis_unit', 'line_total'
      ]
      loop
        if (v_old_line -> v_line_field) is distinct from (v_new_line -> v_line_field) then
          v_line_field_changes := v_line_field_changes
            || jsonb_build_array(jsonb_build_object('field', v_line_field, 'before', v_old_line -> v_line_field, 'after', v_new_line -> v_line_field));
        end if;
      end loop;
      if jsonb_array_length(v_line_field_changes) > 0 then
        v_line_changes := v_line_changes || jsonb_build_array(jsonb_build_object('lineKey', v_key, 'kind', 'modified', 'fields', v_line_field_changes));
      end if;
    end if;
  end loop;

  return jsonb_build_object('headerChanges', v_header_changes, 'lineChanges', v_line_changes);
end;
$$;

revoke all on function public.purchase_document_diff(jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.purchase_document_diff(jsonb, jsonb, jsonb, jsonb) to service_role;

-- Canonical counting rule, shared everywhere a count is needed: each
-- changed header field = 1; each changed field inside a modified line = 1;
-- each added line = 1; each removed line = 1. Never the number of
-- REVIEW_CORRECTED events, and never the number of lineChanges entries
-- directly (a modified line with 3 changed fields counts as 3, not 1).
create or replace function public.purchase_document_diff_count(p_diff jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_array_length(p_diff -> 'headerChanges'), 0)
       + coalesce((
           select sum(
             case when (line_change ->> 'kind') = 'modified'
                  then jsonb_array_length(line_change -> 'fields')
                  else 1
             end
           )::integer
           from jsonb_array_elements(coalesce(p_diff -> 'lineChanges', '[]'::jsonb)) as line_change
         ), 0);
$$;

revoke all on function public.purchase_document_diff_count(jsonb) from public;
grant execute on function public.purchase_document_diff_count(jsonb) to service_role;

-- ============================================================
-- 4. Freeze triggers: narrow, transaction-local capability gate
-- ============================================================
--
-- READY_FOR_VERIFICATION business-field mutation is now allowed, but ONLY
-- inside the two sanctioned RPCs below (save_purchase_document_review_
-- corrections, return_purchase_document_to_draft's restoration) -- never
-- via a generic loosening any service-role caller could exploit. The
-- mechanism: a transaction-local custom GUC
-- (gansevoort.purchase_document_ready_write) that ONLY those two RPC
-- bodies ever set, immediately before their protected UPDATE and only
-- AFTER their own full authorization sequence (actor identity, org scope,
-- manager/admin role at the Server Action layer, status, expected_version,
-- maker-checker identity) has already succeeded -- the flag is a trigger-
-- level capability gate, never itself an authorization mechanism. Being
-- set via set_config(..., is_local => true), it is strictly scoped to the
-- current transaction and is automatically cleared at COMMIT or ROLLBACK,
-- so it can never leak into an unrelated later transaction on a pooled
-- connection, and a raw UPDATE issued directly against the table (or any
-- other RPC) never sets it, so the trigger's default-deny stays fully
-- intact for everything else. verify_purchase_document deliberately never
-- sets this flag -- it should never be attempting a business-field
-- change, so if a future bug ever tried to sneak one in, the trigger still
-- catches it. VERIFIED remains absolutely immutable regardless of the
-- flag -- there is no code path, anywhere, that checks the flag while
-- old.status = 'VERIFIED'.
create or replace function public.purchase_documents_forbid_locked_mutation()
returns trigger
language plpgsql
as $$
declare
  v_business_changed boolean;
begin
  if tg_op = 'DELETE' then
    if old.status in ('VERIFIED', 'READY_FOR_VERIFICATION') then
      raise exception 'purchase_document % is % and cannot be deleted', old.id, old.status
        using errcode = 'GA003';
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE' from here.
  if old.status = 'VERIFIED' then
    raise exception 'purchase_document % is verified and cannot be modified', old.id
      using errcode = 'GA003';
  end if;

  if old.status = 'READY_FOR_VERIFICATION' then
    if new.status not in ('VERIFIED', 'DRAFT', 'READY_FOR_VERIFICATION') then
      raise exception 'purchase_document % is ready for verification and locked from editing', old.id
        using errcode = 'GA003';
    end if;

    v_business_changed :=
      new.vendor_id is distinct from old.vendor_id
      or new.document_type is distinct from old.document_type
      or new.document_number is distinct from old.document_number
      or new.document_date is distinct from old.document_date
      or new.po_number is distinct from old.po_number
      or new.delivery_date is distinct from old.delivery_date
      or new.subtotal is distinct from old.subtotal
      or new.tax is distinct from old.tax
      or new.fees is distinct from old.fees
      or new.total is distinct from old.total
      or new.currency is distinct from old.currency
      or new.source_document_id is distinct from old.source_document_id
      or new.source_extraction_id is distinct from old.source_extraction_id
      or new.created_by_app_user_id is distinct from old.created_by_app_user_id;

    if v_business_changed and coalesce(current_setting('gansevoort.purchase_document_ready_write', true), 'false') <> 'true' then
      raise exception 'purchase_document % is ready for verification and locked from unauthorized business-field changes', old.id
        using errcode = 'GA003';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.purchase_document_lines_forbid_when_locked()
returns trigger
language plpgsql
as $$
declare
  v_parent_status text;
begin
  select pd.status into v_parent_status
    from public.purchase_documents pd
   where pd.id = coalesce(new.purchase_document_id, old.purchase_document_id);

  if v_parent_status = 'VERIFIED' then
    raise exception 'purchase_document_lines for purchase_document % cannot be modified: the purchase document is verified',
      coalesce(new.purchase_document_id, old.purchase_document_id)
      using errcode = 'GA003';
  elsif v_parent_status = 'READY_FOR_VERIFICATION' then
    if coalesce(current_setting('gansevoort.purchase_document_ready_write', true), 'false') <> 'true' then
      raise exception 'purchase_document_lines for purchase_document % cannot be modified: the purchase document is ready for verification and locked',
        coalesce(new.purchase_document_id, old.purchase_document_id)
        using errcode = 'GA003';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Both re-created via CREATE OR REPLACE FUNCTION with unchanged names/
-- signatures -- the existing trigger bindings remain valid, no DROP/
-- CREATE TRIGGER needed.

-- ============================================================
-- 5. Notifications
-- ============================================================

create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  recipient_app_user_id uuid not null,
  type text not null,
  entity_type text not null,
  entity_id uuid not null,
  title text not null,
  body text,
  metadata jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint user_notifications_recipient_org_fk foreign key (recipient_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create index user_notifications_recipient_unread_idx
  on public.user_notifications (recipient_app_user_id, created_at desc)
  where read_at is null;

create index user_notifications_recipient_all_idx
  on public.user_notifications (recipient_app_user_id, created_at desc);

alter table public.user_notifications enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 6. Preparer identity generalization (save/submit)
-- ============================================================
-- Reads purchase_documents.created_by_app_user_id directly instead of
-- joining through documents.uploaded_by_app_user_id. For revision 1 this
-- is a behavioral no-op: initialize_purchase_document_draft (unchanged,
-- below) only ever sets created_by_app_user_id to the already-verified
-- uploader. It's the enabling change for amendment revisions, whose
-- created_by_app_user_id is the amendment's own initiator.

create or replace function public.save_purchase_document_draft(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_header jsonb,
  p_lines jsonb
)
returns table (
  out_purchase_document_id uuid,
  out_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_new_version integer;
begin
  select created_by_app_user_id into v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not edit it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  update public.purchase_documents as pd
     set vendor_id = (p_header->>'vendorId')::uuid,
         document_type = p_header->>'documentType',
         document_number = p_header->>'documentNumber',
         document_date = public.safe_parse_date(p_header->>'documentDate'),
         po_number = p_header->>'poNumber',
         delivery_date = public.safe_parse_date(p_header->>'deliveryDate'),
         subtotal = (p_header->>'subtotal')::numeric,
         tax = (p_header->>'tax')::numeric,
         fees = (p_header->>'fees')::numeric,
         total = (p_header->>'total')::numeric,
         currency = p_header->>'currency',
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'DRAFT'
     and pd.version = p_expected_version
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be saved: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value)
    where line.value ->> 'lineKey' is not null
    group by line.value ->> 'lineKey'
    having count(*) > 1
  ) then
    raise exception 'duplicate line_key values in submitted lines for purchase_document %', p_purchase_document_id;
  end if;

  delete from public.purchase_document_lines as pdl
   where pdl.purchase_document_id = p_purchase_document_id;

  insert into public.purchase_document_lines as pdl (
    id, organization_id, purchase_document_id, line_number, line_key,
    vendor_sku, description, package_quantity, package_unit,
    measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
  )
  select
    gen_random_uuid(), p_organization_id, p_purchase_document_id, ord.idx,
    coalesce((ord.line_json->>'lineKey')::uuid, gen_random_uuid()),
    ord.line_json->>'vendorSku', ord.line_json->>'description',
    (ord.line_json->>'packageQuantity')::numeric, ord.line_json->>'packageUnit',
    (ord.line_json->>'measuredQuantity')::numeric, ord.line_json->>'measuredUnit',
    (ord.line_json->>'unitPrice')::numeric, ord.line_json->>'priceBasisUnit',
    (ord.line_json->>'lineTotal')::numeric
  from (
    select value as line_json, row_number() over () as idx
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  ) as ord;

  return query select p_purchase_document_id, v_new_version;
end;
$$;

create or replace function public.submit_purchase_document_for_verification(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_new_version integer;
  v_snapshot jsonb;
begin
  select created_by_app_user_id into v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not submit it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  update public.purchase_documents as pd
     set status = 'READY_FOR_VERIFICATION',
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'DRAFT'
     and pd.version = p_expected_version
     and pd.vendor_id is not null
     and exists (
       select 1 from public.vendors v
        where v.id = pd.vendor_id and v.organization_id = pd.organization_id and v.is_active
     )
     and pd.document_type in ('INVOICE', 'RECEIPT', 'CREDIT_MEMO')
     and exists (
       select 1 from public.purchase_document_lines pdl where pdl.purchase_document_id = pd.id
     )
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be submitted: not a DRAFT, version is stale, vendor is missing/inactive, document type is unresolved, or there are no lines', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  select jsonb_build_object(
    'version', pd.version,
    'vendor_id', pd.vendor_id,
    'document_type', pd.document_type,
    'document_number', pd.document_number,
    'document_date', pd.document_date,
    'po_number', pd.po_number,
    'delivery_date', pd.delivery_date,
    'subtotal', pd.subtotal,
    'tax', pd.tax,
    'fees', pd.fees,
    'total', pd.total,
    'currency', pd.currency,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'line_key', pdl.line_key,
        'line_number', pdl.line_number,
        'vendor_sku', pdl.vendor_sku,
        'description', pdl.description,
        'package_quantity', pdl.package_quantity,
        'package_unit', pdl.package_unit,
        'measured_quantity', pdl.measured_quantity,
        'measured_unit', pdl.measured_unit,
        'unit_price', pdl.unit_price,
        'price_basis_unit', pdl.price_basis_unit,
        'line_total', pdl.line_total
      ) order by pdl.line_number), '[]'::jsonb)
      from public.purchase_document_lines pdl
      where pdl.purchase_document_id = pd.id
    )
  )
    into v_snapshot
    from public.purchase_documents pd
   where pd.id = p_purchase_document_id;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SUBMITTED', 'purchase_document', p_purchase_document_id, v_snapshot
  );

  return query select p_purchase_document_id, 'READY_FOR_VERIFICATION'::text, v_new_version;
end;
$$;

-- ============================================================
-- 7. save_purchase_document_review_corrections
-- ============================================================
-- The independent verifier's controlled write path. Preparer of THIS
-- revision may NOT use it (GA004, same family as verify's self-check --
-- reviewing/correcting your own submission defeats maker-checker exactly
-- like verifying it would). Every authorization check (actor identity via
-- p_app_user_id -- always server-derived, never client-supplied; org
-- scope; status; expected_version; maker-checker identity) completes
-- BEFORE the transaction-local write-capability flag is ever set, and the
-- flag is set immediately before the one UPDATE it protects. Computes and
-- writes its OWN attributed diff (old = this row's state immediately
-- before this call, new = immediately after) -- never batched with any
-- other save, never written at all if nothing meaningfully changed.
create or replace function public.save_purchase_document_review_corrections(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_header jsonb,
  p_lines jsonb
)
returns table (
  out_purchase_document_id uuid,
  out_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_submission_event_id uuid;
  v_old_header jsonb;
  v_old_lines jsonb;
  v_new_version integer;
  v_new_header jsonb;
  v_new_lines jsonb;
  v_diff jsonb;
begin
  select created_by_app_user_id into v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by = p_app_user_id then
    raise exception 'app_user % prepared purchase_document % and cannot review-correct it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  select jsonb_build_object(
      'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
      'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
      'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
    )
    into v_old_header
    from public.purchase_documents
   where id = p_purchase_document_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
      'package_quantity', package_quantity, 'package_unit', package_unit,
      'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
      'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
    ) order by line_number), '[]'::jsonb)
    into v_old_lines
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id;

  select id into v_submission_event_id
    from public.audit_events
   where entity_type = 'purchase_document'
     and entity_id = p_purchase_document_id
     and action = 'PURCHASE_DOCUMENT_SUBMITTED'
   order by occurred_at desc
   limit 1;

  if v_submission_event_id is null then
    raise exception 'purchase_document % has no submission to correct against', p_purchase_document_id;
  end if;

  -- Only now, after every check above has already succeeded, enable the
  -- narrow trigger-level capability the freeze triggers require.
  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

  update public.purchase_documents as pd
     set vendor_id = (p_header->>'vendorId')::uuid,
         document_type = p_header->>'documentType',
         document_number = p_header->>'documentNumber',
         document_date = public.safe_parse_date(p_header->>'documentDate'),
         po_number = p_header->>'poNumber',
         delivery_date = public.safe_parse_date(p_header->>'deliveryDate'),
         subtotal = (p_header->>'subtotal')::numeric,
         tax = (p_header->>'tax')::numeric,
         fees = (p_header->>'fees')::numeric,
         total = (p_header->>'total')::numeric,
         currency = p_header->>'currency',
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'READY_FOR_VERIFICATION'
     and pd.version = p_expected_version
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be corrected: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value)
    where line.value ->> 'lineKey' is not null
    group by line.value ->> 'lineKey'
    having count(*) > 1
  ) then
    raise exception 'duplicate line_key values in submitted lines for purchase_document %', p_purchase_document_id;
  end if;

  delete from public.purchase_document_lines as pdl
   where pdl.purchase_document_id = p_purchase_document_id;

  insert into public.purchase_document_lines as pdl (
    id, organization_id, purchase_document_id, line_number, line_key,
    vendor_sku, description, package_quantity, package_unit,
    measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
  )
  select
    gen_random_uuid(), p_organization_id, p_purchase_document_id, ord.idx,
    coalesce((ord.line_json->>'lineKey')::uuid, gen_random_uuid()),
    ord.line_json->>'vendorSku', ord.line_json->>'description',
    (ord.line_json->>'packageQuantity')::numeric, ord.line_json->>'packageUnit',
    (ord.line_json->>'measuredQuantity')::numeric, ord.line_json->>'measuredUnit',
    (ord.line_json->>'unitPrice')::numeric, ord.line_json->>'priceBasisUnit',
    (ord.line_json->>'lineTotal')::numeric
  from (
    select value as line_json, row_number() over () as idx
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  ) as ord;

  select jsonb_build_object(
      'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
      'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
      'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
    )
    into v_new_header
    from public.purchase_documents
   where id = p_purchase_document_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
      'package_quantity', package_quantity, 'package_unit', package_unit,
      'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
      'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
    ) order by line_number), '[]'::jsonb)
    into v_new_lines
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id;

  v_diff := public.purchase_document_diff(v_old_header, v_old_lines, v_new_header, v_new_lines);

  if public.purchase_document_diff_count(v_diff) > 0 then
    insert into public.audit_events (
      organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
    ) values (
      p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_REVIEW_CORRECTED', 'purchase_document', p_purchase_document_id,
      v_diff || jsonb_build_object('submissionAuditEventId', v_submission_event_id)
    );
  end if;

  return query select p_purchase_document_id, v_new_version;
end;
$$;

revoke all on function public.save_purchase_document_review_corrections(uuid, uuid, uuid, integer, jsonb, jsonb) from public;
grant execute on function public.save_purchase_document_review_corrections(uuid, uuid, uuid, integer, jsonb, jsonb) to service_role;

-- ============================================================
-- 8. verify_purchase_document (extended)
-- ============================================================
-- finalCorrectionCount is a pure measurement (latest SUBMITTED snapshot vs.
-- the exact state being verified), computed once here, and is NEVER
-- attributed to whoever calls this function -- actor attribution for
-- "who actually touched what" comes exclusively from aggregating this
-- cycle's own PURCHASE_DOCUMENT_REVIEW_CORRECTED events (matched by the
-- exact, immutable submissionAuditEventId, never occurred_at >).
create or replace function public.verify_purchase_document(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer
)
returns table (
  out_purchase_document_id uuid,
  out_verified_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_revision_group_id uuid;
  v_revision_number integer;
  v_source_document_id uuid;
  v_previous_revision_id uuid;
  v_previous_verified_by uuid;
  v_uploaded_by uuid;
  v_verified_at timestamptz;
  v_submission_event_id uuid;
  v_submitted_snapshot jsonb;
  v_submitted_header jsonb;
  v_submitted_lines jsonb;
  v_final_header jsonb;
  v_final_lines jsonb;
  v_final_diff jsonb;
  v_final_correction_count integer;
  v_review_edit_count integer;
  v_reviewers jsonb;
begin
  select created_by_app_user_id, revision_group_id, revision_number, source_document_id, previous_revision_id
    into v_created_by, v_revision_group_id, v_revision_number, v_source_document_id, v_previous_revision_id
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by = p_app_user_id then
    raise exception 'app_user % prepared purchase_document % and cannot also verify it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  update public.purchase_documents as pd
     set status = 'VERIFIED',
         verified_by_app_user_id = p_app_user_id,
         verified_at = now(),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'READY_FOR_VERIFICATION'
     and pd.version = p_expected_version
   returning pd.verified_at into v_verified_at;

  if not found then
    raise exception 'purchase_document % could not be verified: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  select id, after_state into v_submission_event_id, v_submitted_snapshot
    from public.audit_events
   where entity_type = 'purchase_document'
     and entity_id = p_purchase_document_id
     and action = 'PURCHASE_DOCUMENT_SUBMITTED'
   order by occurred_at desc
   limit 1;

  v_submitted_header := v_submitted_snapshot - 'lines' - 'version';
  v_submitted_lines := coalesce(v_submitted_snapshot -> 'lines', '[]'::jsonb);

  select jsonb_build_object(
      'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
      'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
      'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
    )
    into v_final_header
    from public.purchase_documents
   where id = p_purchase_document_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
      'package_quantity', package_quantity, 'package_unit', package_unit,
      'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
      'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
    ) order by line_number), '[]'::jsonb)
    into v_final_lines
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id;

  -- Legacy pre-2A.2.1 submissions have no line_key in their stored
  -- snapshot lines -- degrade to header-only diffing rather than guessing
  -- a line correlation that was never captured.
  if jsonb_array_length(v_submitted_lines) > 0 and not (v_submitted_lines -> 0 ? 'line_key') then
    v_final_diff := jsonb_build_object(
      'headerChanges', (public.purchase_document_diff(v_submitted_header, '[]'::jsonb, v_final_header, '[]'::jsonb) -> 'headerChanges'),
      'lineChanges', '[]'::jsonb
    );
  else
    v_final_diff := public.purchase_document_diff(v_submitted_header, v_submitted_lines, v_final_header, v_final_lines);
  end if;
  v_final_correction_count := public.purchase_document_diff_count(v_final_diff);

  select coalesce(jsonb_agg(jsonb_build_object('appUserId', actor_app_user_id, 'fieldTouchCount', field_count)), '[]'::jsonb),
         coalesce(sum(field_count), 0)
    into v_reviewers, v_review_edit_count
    from (
      select ae.actor_app_user_id, sum(public.purchase_document_diff_count(ae.after_state))::integer as field_count
        from public.audit_events ae
       where ae.entity_type = 'purchase_document'
         and ae.entity_id = p_purchase_document_id
         and ae.action = 'PURCHASE_DOCUMENT_REVIEW_CORRECTED'
         and (ae.after_state ->> 'submissionAuditEventId') = v_submission_event_id::text
       group by ae.actor_app_user_id
    ) as per_actor;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_VERIFIED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object(
      'version', p_expected_version,
      'submissionAuditEventId', v_submission_event_id,
      'finalCorrectionCount', v_final_correction_count,
      'reviewEditCount', v_review_edit_count
    )
  );

  select d.uploaded_by_app_user_id into v_uploaded_by
    from public.documents d
   where d.id = v_source_document_id;

  if v_revision_number = 1 then
    if v_final_correction_count > 0 then
      insert into public.user_notifications (
        organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
      ) values (
        p_organization_id, v_created_by, 'PURCHASE_DOCUMENT_VERIFIED_WITH_CORRECTIONS', 'purchase_document', p_purchase_document_id,
        'Invoice verified with corrections',
        format('%s final correction(s) were made during review.', v_final_correction_count),
        jsonb_build_object(
          'finalCorrectionCount', v_final_correction_count,
          'reviewEditCount', v_review_edit_count,
          'reviewEditors', v_reviewers,
          'verifiedByAppUserId', p_app_user_id
        )
      );
    end if;
  else
    select verified_by_app_user_id into v_previous_verified_by
      from public.purchase_documents
     where id = v_previous_revision_id;

    insert into public.user_notifications (
      organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
    )
    select p_organization_id, recipient, 'PURCHASE_DOCUMENT_AMENDMENT_VERIFIED', 'purchase_document', p_purchase_document_id,
      'Amendment verified',
      format('An amended revision (Rev %s) was verified.', v_revision_number),
      jsonb_build_object(
        'finalCorrectionCount', v_final_correction_count,
        'reviewEditCount', v_review_edit_count,
        'reviewEditors', v_reviewers,
        'verifiedByAppUserId', p_app_user_id,
        'revisionNumber', v_revision_number,
        'previousRevisionId', v_previous_revision_id
      )
    from (select distinct r as recipient from unnest(array[v_uploaded_by, v_previous_verified_by]) as r where r is not null) as recipients;
  end if;

  return query select p_purchase_document_id, v_verified_at;
end;
$$;

-- ============================================================
-- 9. return_purchase_document_to_draft (extended: restore from snapshot)
-- ============================================================
create or replace function public.return_purchase_document_to_draft(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_reason text default null
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_new_version integer;
  v_submitted_snapshot jsonb;
  v_submitted_header jsonb;
  v_submitted_lines jsonb;
begin
  select created_by_app_user_id into v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by = p_app_user_id then
    raise exception 'app_user % prepared purchase_document % and cannot return it to draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  select after_state into v_submitted_snapshot
    from public.audit_events
   where entity_type = 'purchase_document'
     and entity_id = p_purchase_document_id
     and action = 'PURCHASE_DOCUMENT_SUBMITTED'
   order by occurred_at desc
   limit 1;

  if v_submitted_snapshot is null then
    raise exception 'purchase_document % has no submission snapshot to restore', p_purchase_document_id;
  end if;

  v_submitted_header := v_submitted_snapshot - 'lines' - 'version';
  v_submitted_lines := coalesce(v_submitted_snapshot -> 'lines', '[]'::jsonb);

  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

  update public.purchase_documents as pd
     set status = 'DRAFT',
         vendor_id = (v_submitted_header->>'vendor_id')::uuid,
         document_type = v_submitted_header->>'document_type',
         document_number = v_submitted_header->>'document_number',
         document_date = (v_submitted_header->>'document_date')::date,
         po_number = v_submitted_header->>'po_number',
         delivery_date = (v_submitted_header->>'delivery_date')::date,
         subtotal = (v_submitted_header->>'subtotal')::numeric,
         tax = (v_submitted_header->>'tax')::numeric,
         fees = (v_submitted_header->>'fees')::numeric,
         total = (v_submitted_header->>'total')::numeric,
         currency = v_submitted_header->>'currency',
         last_returned_by_app_user_id = p_app_user_id,
         last_returned_reason = p_reason,
         last_returned_at = now(),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'READY_FOR_VERIFICATION'
     and pd.version = p_expected_version
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be returned to draft: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  delete from public.purchase_document_lines as pdl
   where pdl.purchase_document_id = p_purchase_document_id;

  insert into public.purchase_document_lines as pdl (
    id, organization_id, purchase_document_id, line_number, line_key,
    vendor_sku, description, package_quantity, package_unit,
    measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
  )
  select
    gen_random_uuid(), p_organization_id, p_purchase_document_id, ord.idx,
    coalesce((ord.line_json->>'line_key')::uuid, gen_random_uuid()),
    ord.line_json->>'vendor_sku', ord.line_json->>'description',
    (ord.line_json->>'package_quantity')::numeric, ord.line_json->>'package_unit',
    (ord.line_json->>'measured_quantity')::numeric, ord.line_json->>'measured_unit',
    (ord.line_json->>'unit_price')::numeric, ord.line_json->>'price_basis_unit',
    (ord.line_json->>'line_total')::numeric
  from (
    select value as line_json, row_number() over () as idx
    from jsonb_array_elements(v_submitted_lines)
  ) as ord;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_RETURNED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('version', p_expected_version, 'reason', p_reason)
  );

  return query select p_purchase_document_id, 'DRAFT'::text, v_new_version;
end;
$$;

-- ============================================================
-- 10. initiate_purchase_document_amendment
-- ============================================================
create or replace function public.initiate_purchase_document_amendment(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_reason text
)
returns table (
  out_purchase_document_id uuid,
  out_revision_number integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior public.purchase_documents%rowtype;
  v_current_verified_id uuid;
  v_new_id uuid;
  v_new_revision_number integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'an amendment reason is required';
  end if;

  select * into v_prior
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_prior.status <> 'VERIFIED' then
    raise exception 'purchase_document % is not verified and cannot be amended', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  v_current_verified_id := public.current_verified_purchase_document_revision_id(p_organization_id, v_prior.revision_group_id);
  if v_current_verified_id is distinct from p_purchase_document_id then
    raise exception 'purchase_document % is a superseded revision and cannot be amended directly', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  v_new_id := gen_random_uuid();
  v_new_revision_number := v_prior.revision_number + 1;

  insert into public.purchase_documents as pd (
    id, organization_id, source_document_id, source_extraction_id,
    vendor_id, document_type, document_number, document_date, po_number, delivery_date,
    subtotal, tax, fees, total, currency,
    status, created_by_app_user_id,
    revision_group_id, revision_number, previous_revision_id, amendment_reason
  ) values (
    v_new_id, p_organization_id, v_prior.source_document_id, v_prior.source_extraction_id,
    v_prior.vendor_id, v_prior.document_type, v_prior.document_number, v_prior.document_date, v_prior.po_number, v_prior.delivery_date,
    v_prior.subtotal, v_prior.tax, v_prior.fees, v_prior.total, v_prior.currency,
    'DRAFT', p_app_user_id,
    v_prior.revision_group_id, v_new_revision_number, v_prior.id, p_reason
  );

  insert into public.purchase_document_lines as pdl (
    id, organization_id, purchase_document_id, line_number, line_key,
    vendor_sku, description, package_quantity, package_unit,
    measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
  )
  select
    gen_random_uuid(), p_organization_id, v_new_id, src.line_number, gen_random_uuid(),
    src.vendor_sku, src.description, src.package_quantity, src.package_unit,
    src.measured_quantity, src.measured_unit, src.unit_price, src.price_basis_unit, src.line_total
  from public.purchase_document_lines src
  where src.purchase_document_id = p_purchase_document_id;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_AMENDMENT_INITIATED', 'purchase_document', v_new_id,
    jsonb_build_object('reason', p_reason, 'previousRevisionId', p_purchase_document_id, 'revisionNumber', v_new_revision_number)
  );

  return query select v_new_id, v_new_revision_number;
end;
$$;

revoke all on function public.initiate_purchase_document_amendment(uuid, uuid, uuid, text) from public;
grant execute on function public.initiate_purchase_document_amendment(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 11. search_receiving_queue: revision-aware (one row per business
--     document, never one per revision)
-- ============================================================
-- Return shape changes (two new output columns), so this requires DROP +
-- CREATE rather than CREATE OR REPLACE.
drop function if exists public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer);

create function public.search_receiving_queue(
  p_organization_id uuid,
  p_vendor_id uuid default null,
  p_uploaded_by_app_user_id uuid default null,
  p_status text default null,
  p_document_type text default null,
  p_date_type text default 'uploaded',
  p_date_from date default null,
  p_date_to date default null,
  p_query text default null,
  p_limit integer default 200
)
returns table (
  out_document_id uuid,
  out_original_filename text,
  out_content_type text,
  out_created_at timestamptz,
  out_uploaded_by_app_user_id uuid,
  out_purchase_document_id uuid,
  out_effective_vendor_id uuid,
  out_effective_document_type text,
  out_declared_vendor_id uuid,
  out_declared_document_type text,
  out_document_number text,
  out_document_date date,
  out_status text,
  out_verified_by_app_user_id uuid,
  out_revision_number integer,
  out_current_verified_revision_number integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with latest_attempt as (
    select distinct on (de.document_id)
      de.document_id, de.status as attempt_status, de.requested_at, de.started_at
    from public.document_extractions de
    where de.organization_id = p_organization_id
    order by de.document_id, de.attempt_number desc
  ),
  merged as (
    select
      d.id as document_id,
      d.original_filename,
      d.content_type,
      d.created_at,
      d.uploaded_by_app_user_id,
      d.vendor_id as declared_vendor_id,
      d.declared_document_type,
      pd.id as purchase_document_id,
      coalesce(pd.vendor_id, d.vendor_id) as effective_vendor_id,
      coalesce(pd.document_type, d.declared_document_type) as effective_document_type,
      pd.document_number,
      pd.document_date,
      pd.verified_by_app_user_id,
      pd.revision_number,
      current_verified.revision_number as current_verified_revision_number,
      case
        when pd.status is not null then pd.status
        when la.document_id is null then 'FAILED'
        when la.attempt_status = 'SUCCEEDED' then 'NEEDS_REVIEW'
        when la.attempt_status = 'FAILED' then 'FAILED'
        when la.attempt_status in ('PENDING', 'RUNNING') then
          case
            when now() - coalesce(
              case when la.attempt_status = 'RUNNING' then la.started_at end,
              la.requested_at
            ) > interval '5 minutes'
            then 'STALLED'
            else 'PROCESSING'
          end
        else 'FAILED'
      end as computed_status
    from public.documents d
    -- Exactly one effective purchase_document per source document, even
    -- though revisions now mean the real relationship is one-to-many:
    -- prefer an open (non-VERIFIED) revision if one exists (there is at
    -- most one, enforced by purchase_documents_one_open_revision_per_group),
    -- otherwise the highest-revision_number VERIFIED row. This is the
    -- "effective workflow revision" -- see the module comment on
    -- current_verified_purchase_document_revision_id for the distinct
    -- "current verified revision" concept.
    left join lateral (
      select pd.*
        from public.purchase_documents pd
       where pd.source_document_id = d.id and pd.organization_id = d.organization_id
       order by (pd.status <> 'VERIFIED') desc, pd.revision_number desc
       limit 1
    ) pd on true
    left join lateral (
      select cv.revision_number
        from public.purchase_documents cv
       where cv.revision_group_id = pd.revision_group_id and cv.status = 'VERIFIED'
       order by cv.revision_number desc
       limit 1
    ) current_verified on true
    left join latest_attempt la on la.document_id = d.id
    where d.organization_id = p_organization_id
  )
  select
    m.document_id, m.original_filename, m.content_type, m.created_at, m.uploaded_by_app_user_id,
    m.purchase_document_id, m.effective_vendor_id, m.effective_document_type,
    m.declared_vendor_id, m.declared_document_type,
    m.document_number, m.document_date, m.computed_status, m.verified_by_app_user_id,
    m.revision_number, m.current_verified_revision_number
  from merged m
  where (p_vendor_id is null or m.effective_vendor_id = p_vendor_id)
    and (p_uploaded_by_app_user_id is null or m.uploaded_by_app_user_id = p_uploaded_by_app_user_id)
    and (p_status is null or m.computed_status = p_status)
    and (p_document_type is null or m.effective_document_type = p_document_type)
    and (
      p_date_type <> 'business'
      or (
        m.document_date is not null
        and (p_date_from is null or m.document_date >= p_date_from)
        and (p_date_to is null or m.document_date <= p_date_to)
      )
    )
    and (
      p_date_type = 'business'
      or (
        (p_date_from is null or m.created_at >= p_date_from::timestamptz)
        and (p_date_to is null or m.created_at < (p_date_to + 1)::timestamptz)
      )
    )
    and (
      p_query is null or btrim(p_query) = ''
      or m.original_filename ilike '%' || p_query || '%'
      or m.document_number ilike '%' || p_query || '%'
    )
  order by m.created_at desc
  limit p_limit;
$$;

revoke all on function public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer) from public;
grant execute on function public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer) to service_role;
