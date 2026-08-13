-- Milestone 2A.2.1 cleanup: users had no provision to remove accidental
-- uploads/drafts or abandon an in-progress amendment. Everything here is
-- auditable discard/archive, never a hard delete -- VERIFIED purchase
-- documents remain permanently immutable and undeletable, exactly as
-- before.
--
-- 1. A new terminal purchase_documents status, DISCARDED. Only reachable
--    from DRAFT (never directly from READY_FOR_VERIFICATION or VERIFIED).
--    Once DISCARDED, a row is as frozen as a VERIFIED one -- both freeze
--    triggers are extended to say so.
-- 2. discard_purchase_document_draft -- preparer-only, DRAFT -> DISCARDED.
--    Reason required for an amendment (revision_number > 1), optional for
--    an original never-submitted draft (revision_number = 1).
-- 3. withdraw_purchase_document_submission -- preparer-only,
--    READY_FOR_VERIFICATION -> DRAFT, restoring the latest
--    PURCHASE_DOCUMENT_SUBMITTED snapshot exactly like
--    return_purchase_document_to_draft (reviewer corrections are never
--    silently promoted into the restored draft; they remain in audit
--    history as discarded review activity).
-- 4. The one-open-revision-per-group index is redefined so DISCARDED no
--    longer counts as "open" -- a discarded amendment never blocks a
--    future one. initiate_purchase_document_amendment is corrected to
--    number the next revision from the highest revision_number the group
--    has EVER used (not just the row being amended), so a discarded
--    revision's number is never reused and history stays monotonic
--    (Rev 1 VERIFIED, Rev 2 DISCARDED, next amendment -> Rev 3).
-- 5. search_receiving_queue never selects a DISCARDED row as the
--    "effective" revision, and a source document whose only revision was
--    discarded disappears from the queue entirely (never falls back to
--    re-showing a stale "Needs Review" state).
-- 6. documents gains archived_at/archived_by_app_user_id/archive_reason
--    and archive_document, for an upload that never became a purchase
--    document (or whose only purchase_document is itself discarded) --
--    archived uploads are hidden from the queue, storage is untouched.

-- ============================================================
-- 1. Schema
-- ============================================================

alter table public.purchase_documents
  add column discarded_by_app_user_id uuid,
  add column discarded_at timestamptz,
  add column discard_reason text;

alter table public.purchase_documents
  drop constraint purchase_documents_status_check;
alter table public.purchase_documents
  add constraint purchase_documents_status_check
  check (status in ('DRAFT', 'READY_FOR_VERIFICATION', 'VERIFIED', 'DISCARDED'));

-- Redefined: DISCARDED (like VERIFIED) no longer counts as an open
-- revision, so it can never block a future amendment attempt on the same
-- group.
drop index public.purchase_documents_one_open_revision_per_group;
create unique index purchase_documents_one_open_revision_per_group
  on public.purchase_documents (organization_id, revision_group_id)
  where status in ('DRAFT', 'READY_FOR_VERIFICATION');

alter table public.documents
  add column archived_at timestamptz,
  add column archived_by_app_user_id uuid,
  add column archive_reason text;

-- ============================================================
-- 2. Freeze triggers: DISCARDED is as frozen as VERIFIED
-- ============================================================

create or replace function public.purchase_documents_forbid_locked_mutation()
returns trigger
language plpgsql
as $$
declare
  v_business_changed boolean;
begin
  if tg_op = 'DELETE' then
    if old.status in ('VERIFIED', 'READY_FOR_VERIFICATION', 'DISCARDED') then
      raise exception 'purchase_document % is % and cannot be deleted', old.id, old.status
        using errcode = 'GA003';
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE' from here.
  if old.status in ('VERIFIED', 'DISCARDED') then
    raise exception 'purchase_document % is % and cannot be modified', old.id, old.status
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

  if v_parent_status in ('VERIFIED', 'DISCARDED') then
    raise exception 'purchase_document_lines for purchase_document % cannot be modified: the purchase document is %',
      coalesce(new.purchase_document_id, old.purchase_document_id), v_parent_status
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

-- ============================================================
-- 3. discard_purchase_document_draft
-- ============================================================
create or replace function public.discard_purchase_document_draft(
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
  v_revision_number integer;
  v_new_version integer;
begin
  select created_by_app_user_id, revision_number into v_created_by, v_revision_number
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not discard it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  -- Reason required for an amendment (revision_number > 1); optional for
  -- an original, never-submitted draft.
  if v_revision_number > 1 and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'a reason is required to discard an amendment draft';
  end if;

  update public.purchase_documents as pd
     set status = 'DISCARDED',
         discarded_by_app_user_id = p_app_user_id,
         discarded_at = now(),
         discard_reason = p_reason,
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'DRAFT'
     and pd.version = p_expected_version
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be discarded: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_DISCARDED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('reason', p_reason, 'revisionNumber', v_revision_number)
  );

  return query select p_purchase_document_id, 'DISCARDED'::text, v_new_version;
end;
$$;

revoke all on function public.discard_purchase_document_draft(uuid, uuid, uuid, integer, text) from public;
grant execute on function public.discard_purchase_document_draft(uuid, uuid, uuid, integer, text) to service_role;

-- ============================================================
-- 4. withdraw_purchase_document_submission
-- ============================================================
-- Preparer-only (the opposite identity check from verify/return, which are
-- non-preparer-only) -- mirrors return_purchase_document_to_draft's
-- snapshot restoration exactly, so reviewer corrections saved during this
-- submission cycle are never silently promoted into the restored draft;
-- they remain in audit history as discarded review activity, same as a
-- reviewer-initiated return.
create or replace function public.withdraw_purchase_document_submission(
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

  if v_created_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not withdraw it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
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
    raise exception 'purchase_document % could not be withdrawn: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
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
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SUBMISSION_WITHDRAWN', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('version', p_expected_version, 'reason', p_reason)
  );

  return query select p_purchase_document_id, 'DRAFT'::text, v_new_version;
end;
$$;

revoke all on function public.withdraw_purchase_document_submission(uuid, uuid, uuid, integer, text) from public;
grant execute on function public.withdraw_purchase_document_submission(uuid, uuid, uuid, integer, text) to service_role;

-- ============================================================
-- 5. initiate_purchase_document_amendment: monotonic revision numbering
-- ============================================================
-- Only change from the 20260811100029 version: the new revision number is
-- the highest revision_number the group has EVER used, plus one -- not
-- simply the row being amended plus one. Without this, discarding Rev 2
-- and later amending Rev 1 again would compute Rev 2 a second time and
-- fail the (organization_id, revision_group_id, revision_number) unique
-- constraint against the still-present (discarded, never deleted) Rev 2
-- row -- worse, if that constraint didn't exist, it would silently reuse
-- a number that already has real history attached to it.
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

  select coalesce(max(revision_number), v_prior.revision_number) + 1
    into v_new_revision_number
    from public.purchase_documents
   where revision_group_id = v_prior.revision_group_id;

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

-- ============================================================
-- 6. archive_document (uploads with no active purchase_document)
-- ============================================================
create or replace function public.archive_document(
  p_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_reason text default null
)
returns table (
  out_document_id uuid,
  out_archived_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uploaded_by uuid;
  v_archived_at timestamptz;
begin
  select uploaded_by_app_user_id into v_uploaded_by
    from public.documents
   where id = p_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'document % not found', p_document_id;
  end if;

  if v_uploaded_by is distinct from p_app_user_id then
    raise exception 'app_user % did not upload document % and may not archive it', p_app_user_id, p_document_id
      using errcode = 'GA006';
  end if;

  -- Only allowed once every purchase_document ever created from this
  -- upload (if any) is DISCARDED -- a document backing an active
  -- DRAFT/READY_FOR_VERIFICATION/VERIFIED business record is never
  -- archivable through this path.
  if exists (
    select 1 from public.purchase_documents pd
     where pd.source_document_id = p_document_id
       and pd.organization_id = p_organization_id
       and pd.status <> 'DISCARDED'
  ) then
    raise exception 'document % backs an active purchase_document workflow and cannot be archived', p_document_id
      using errcode = 'GA002';
  end if;

  update public.documents as d
     set archived_at = now(),
         archived_by_app_user_id = p_app_user_id,
         archive_reason = p_reason
   where d.id = p_document_id
     and d.organization_id = p_organization_id
     and d.archived_at is null
   returning d.archived_at into v_archived_at;

  if not found then
    raise exception 'document % could not be archived: already archived', p_document_id
      using errcode = 'GA002';
  end if;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'DOCUMENT_ARCHIVED', 'document', p_document_id,
    jsonb_build_object('reason', p_reason)
  );

  return query select p_document_id, v_archived_at;
end;
$$;

revoke all on function public.archive_document(uuid, uuid, uuid, text) from public;
grant execute on function public.archive_document(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 7. search_receiving_queue: DISCARDED-aware, archived-aware
-- ============================================================
-- Same signature/return shape as 20260811100029's version -- CREATE OR
-- REPLACE is sufficient, no DROP+CREATE needed.
create or replace function public.search_receiving_queue(
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
    -- Never a DISCARDED row -- prefer an open (DRAFT/READY_FOR_VERIFICATION)
    -- revision if one exists, otherwise the highest-revision_number
    -- VERIFIED row. A source document whose only revision(s) are all
    -- DISCARDED resolves pd to null here, same as one that never had a
    -- purchase_document at all -- distinguished below so it disappears
    -- from the queue instead of incorrectly falling back to a stale
    -- extraction-derived status.
    left join lateral (
      select pd.*
        from public.purchase_documents pd
       where pd.source_document_id = d.id and pd.organization_id = d.organization_id
         and pd.status <> 'DISCARDED'
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
      and d.archived_at is null
      and not (
        pd.id is null
        and exists (
          select 1 from public.purchase_documents pd_discarded
           where pd_discarded.source_document_id = d.id
             and pd_discarded.organization_id = d.organization_id
             and pd_discarded.revision_number = 1
             and pd_discarded.status = 'DISCARDED'
        )
      )
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

-- ============================================================
-- 8. Duplicate detection: DISCARDED never counts as an active match
-- ============================================================
-- (findPossibleDuplicatePurchaseDocuments' TS query gains a
-- .neq("status", "DISCARDED") filter -- no SQL object backs that query,
-- so there is nothing further to change here.)
