-- Permission-gated single-manager invoice posting.
--
-- Adds a genuine, minimal RBAC permission layer on top of the existing
-- roles/user_roles tables (docs/DATABASE.md's Identity and Access domain
-- already names "role_permissions" as part of this schema -- it had never
-- actually been created until now). An authorized manager (granted a new
-- "purchase_sole_approver" role, individually, by an Admin -- Manager/Admin
-- job title alone never implies it) can post a fully-valid invoice without
-- waiting for an independent second reviewer. This is a controlled
-- single-manager APPROVAL, not a bypass of any other safeguard:
--
--   * The permission only ever substitutes for the missing SECOND HUMAN
--     REVIEW step (verify_purchase_document's normal Manager-2 path).
--   * Every other completeness gate remains fully authoritative and
--     unmodified: purchase_document_preparation_incomplete (unresolved
--     item mapping / receiving), purchase_document_missing_delivery_
--     verifier, purchase_document_has_implausible_date (all reused
--     byte-for-byte from 20260811100047/100056/100099), and
--     post_purchase_document_inventory's own blocker scan + the
--     amendment-lineage-already-posted guard (20260811100132) -- called
--     UNMODIFIED, in the SAME transaction, immediately after this
--     document is marked VERIFIED, so verify+post succeed or fail
--     together and inherit its existing idempotent-posting behavior.
--   * Purchase-package mismatch, invoice-total discrepancy, and
--     unresolved-duplicate checks are deliberately NOT re-derived here in
--     SQL (they exist today only as richer TypeScript-side computations:
--     packageUnitMismatch.ts, validatePurchaseDocumentDraft.ts,
--     duplicateDetection.ts) -- the ONLY legitimate path to this RPC is
--     the server action in app/actions/purchaseDocuments.ts, which
--     re-checks all three, server-side, before ever calling this
--     function. Never a second, competing re-implementation of any of
--     them in SQL.
--
-- New error codes: GA076 (caller lacks the permission), GA077 (reserved,
-- unused -- GA002/GA013/GA075/GA017 are reused for their identical
-- existing meanings), GA078 (missing reason for sole-approver posting).

-- ============================================================
-- 1. permissions + role_permissions (docs/DATABASE.md's documented,
--    previously-uncreated tables)
-- ============================================================
create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  description text not null,
  created_at timestamptz not null default now()
);

create unique index permissions_lower_key_key on public.permissions (lower(key));

create table public.role_permissions (
  role_id uuid not null references public.roles (id),
  permission_id uuid not null references public.permissions (id),
  primary key (role_id, permission_id)
);

alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
-- Deny-by-default: no policies for anon/authenticated (matches roles/user_roles).

insert into public.permissions (key, description) values
  ('purchase_documents.post_without_second_review', 'Can post validated invoices without an independent second reviewer');

-- A dedicated role, granted to INDIVIDUAL managers by an Admin (via
-- user_roles, exactly like any other role grant) -- never implied by
-- holding the "manager" or "admin" role itself.
insert into public.roles (name, description) values
  ('purchase_sole_approver', 'Can post validated invoices without an independent second reviewer -- granted individually by an Admin.');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r, public.permissions p
 where r.name = 'purchase_sole_approver'
   and p.key = 'purchase_documents.post_without_second_review';

-- ============================================================
-- 2. has_permission -- the one authoritative, non-bypassable permission
--    check, reusable by any future RPC.
-- ============================================================
create or replace function public.has_permission(
  p_app_user_id uuid,
  p_organization_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions perm on perm.id = rp.permission_id
     where ur.app_user_id = p_app_user_id
       and ur.organization_id = p_organization_id
       and perm.key = p_permission_key
  );
$$;

revoke all on function public.has_permission(uuid, uuid, text) from public;
grant execute on function public.has_permission(uuid, uuid, text) to service_role;

-- ============================================================
-- 3. purchase_documents: sole-approver provenance columns
-- ============================================================
alter table public.purchase_documents
  add column verification_method text,
  add column sole_approver_reason text,
  add column sole_approver_notes text;

alter table public.purchase_documents
  add constraint purchase_documents_verification_method_check
    check (verification_method is null or verification_method = 'SOLE_APPROVER');

alter table public.purchase_documents
  add constraint purchase_documents_sole_approver_reason_check
    check (sole_approver_reason is null or sole_approver_reason in (
      'SECOND_REVIEWER_UNAVAILABLE', 'TIME_SENSITIVE_RECEIVING', 'MANAGER_COMPLETED_FULL_REVIEW', 'OTHER'
    ));

-- ============================================================
-- 4. post_purchase_document_sole_approver -- DRAFT -> VERIFIED (as sole
--    approver) -> POSTED, atomically, in one call.
-- ============================================================
create or replace function public.post_purchase_document_sole_approver(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_reason text,
  p_notes text,
  p_idempotency_key uuid default null
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_verified_at timestamptz,
  out_verification_method text,
  out_posting_status text,
  out_posting_id uuid,
  out_posted_line_count integer,
  out_movement_count integer,
  out_invoice_total numeric,
  out_inventory_value numeric,
  out_inventory_line_count integer,
  out_expense_line_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_version integer;
  v_revision_group_id uuid;
  v_document_date date;
  v_total numeric;
  v_document_number text;
  v_vendor_id uuid;
  v_new_version integer;
  v_verified_at timestamptz;
  v_inventory_value numeric;
  v_inventory_line_count integer;
  v_expense_line_count integer;
  v_actor_name text;
  v_locations jsonb;
  v_posting record;
  v_notify_error text;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required for single-manager approval' using errcode = 'GA078';
  end if;

  -- Locks the row before any other check -- a concurrent sole-approver
  -- or normal-verify attempt on the same document serializes behind this.
  select status, version, revision_group_id, document_date, total, document_number, vendor_id
    into v_status, v_version, v_revision_group_id, v_document_date, v_total, v_document_number, v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id
   for update;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if not public.has_permission(p_app_user_id, p_organization_id, 'purchase_documents.post_without_second_review') then
    raise exception 'app_user % does not have permission to post without a second reviewer', p_app_user_id
      using errcode = 'GA076';
  end if;

  if v_status <> 'DRAFT' or v_version <> p_expected_version then
    raise exception 'purchase_document % could not be posted as sole approver: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  -- The SAME completeness gate submit_purchase_document_for_verification
  -- enforces (20260811100047/100056) -- unresolved item mapping/
  -- receiving, missing delivery verifier, implausible date. Reused
  -- unmodified; never a second, looser gate for this path.
  if public.purchase_document_preparation_incomplete(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has incomplete item mapping/receiving preparation', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if public.purchase_document_missing_delivery_verifier(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has one or more inventory lines but no delivery verifier recorded', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if public.purchase_document_has_implausible_date(v_document_date) then
    raise exception 'purchase_document % has an implausible document date', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  -- Amendment lineage already posted (20260811100132's own guard) --
  -- checked again here, BEFORE this document is marked VERIFIED, so a
  -- lineage that already posted is refused cleanly rather than left
  -- VERIFIED-but-can-never-post (post_purchase_document_inventory below
  -- enforces this identically regardless; this earlier check just gives
  -- a clean refusal without a partial state change).
  if exists (
    select 1
      from public.purchase_document_inventory_postings pip
      join public.purchase_documents sibling
        on sibling.id = pip.purchase_document_id and sibling.organization_id = p_organization_id
     where pip.organization_id = p_organization_id
       and sibling.revision_group_id = v_revision_group_id
       and sibling.id <> p_purchase_document_id
  ) then
    raise exception 'purchase_document % cannot post -- another revision in this amendment lineage has already posted inventory for this business document', p_purchase_document_id
      using errcode = 'GA075';
  end if;

  update public.purchase_documents as pd
     set status = 'VERIFIED',
         verified_by_app_user_id = p_app_user_id,
         verified_at = now(),
         verification_method = 'SOLE_APPROVER',
         sole_approver_reason = btrim(p_reason),
         sole_approver_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'DRAFT'
     and pd.version = p_expected_version
   returning pd.version, pd.verified_at into v_new_version, v_verified_at;

  if not found then
    raise exception 'purchase_document % could not be posted as sole approver: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  -- Structured inventory-value/line-count facts, computed authoritatively
  -- here (never trusted from the client) for the audit event and the
  -- returned summary.
  select
    coalesce(sum(pdl.line_total) filter (where c.disposition = 'INVENTORY'), 0),
    count(*) filter (where c.disposition = 'INVENTORY'),
    count(*) filter (where c.disposition = 'NON_INVENTORY')
    into v_inventory_value, v_inventory_line_count, v_expense_line_count
    from public.purchase_document_lines pdl
    join public.purchase_document_line_classifications c
      on c.organization_id = pdl.organization_id
     and c.purchase_document_id = pdl.purchase_document_id
     and c.line_key = pdl.line_key
   where pdl.purchase_document_id = p_purchase_document_id
     and pdl.organization_id = p_organization_id;

  select coalesce(jsonb_agg(distinct l.name), '[]'::jsonb)
    into v_locations
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
    join public.receipt_lines rl on rl.receipt_id = er.id
    join public.storage_locations l on l.id = rl.location_id and l.organization_id = p_organization_id
   where rl.matched_line_key is not null;

  select (e.first_name || ' ' || e.last_name) into v_actor_name
    from public.app_users au
    join public.employees e on e.id = au.employee_id
   where au.id = p_app_user_id and au.organization_id = p_organization_id;

  -- Post to inventory immediately, in the SAME transaction -- verify and
  -- post succeed or fail together. Calls post_purchase_document_inventory
  -- completely UNMODIFIED: its own blocker scan (unresolved item,
  -- purchase-package-unit mismatch, missing quantity/location/
  -- measurement) and its amendment-lineage-already-posted guard both
  -- apply here exactly as they do to the normal Manager-2 path, and its
  -- existing unique-receipt-line-id idempotency means a concurrent
  -- second call converges on ALREADY_POSTED rather than double-posting.
  select * into v_posting from public.post_purchase_document_inventory(p_purchase_document_id, p_organization_id, p_app_user_id);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_POSTED_SOLE_APPROVER', 'purchase_document', p_purchase_document_id,
    jsonb_build_object(
      'purchaseDocumentId', p_purchase_document_id,
      'revisionGroupId', v_revision_group_id,
      'actorAppUserId', p_app_user_id,
      'actorName', v_actor_name,
      'permissionUsed', 'purchase_documents.post_without_second_review',
      'reason', btrim(p_reason),
      'notes', nullif(btrim(coalesce(p_notes, '')), ''),
      'occurredAt', v_verified_at,
      'invoiceTotal', v_total,
      'inventoryValue', v_inventory_value,
      'inventoryLineCount', v_inventory_line_count,
      'expenseLineCount', v_expense_line_count,
      'postingStatus', v_posting.out_status,
      'postingId', v_posting.out_posting_id,
      'postedLineCount', v_posting.out_posted_line_count,
      'movementCount', v_posting.out_movement_count,
      'idempotencyKey', p_idempotency_key,
      'vendorId', v_vendor_id,
      'documentNumber', v_document_number,
      'locations', v_locations
    )
  );

  -- Informational notification to every OTHER active Admin -- never a
  -- second approval request, never blocking: a failure here is caught
  -- and recorded as its own audit event, not allowed to roll back an
  -- already-successful verify+post.
  begin
    insert into public.user_notifications (organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata)
    select p_organization_id, au.id, 'PURCHASE_DOCUMENT_SOLE_APPROVER_POSTED', 'purchase_document', p_purchase_document_id,
           'Invoice posted by sole approver',
           coalesce(v_actor_name, 'A manager') || ' posted purchase document ' || coalesce(v_document_number, p_purchase_document_id::text) ||
             ' without a second reviewer.',
           jsonb_build_object('reason', btrim(p_reason), 'invoiceTotal', v_total)
      from public.app_users au
      join public.user_roles ur on ur.app_user_id = au.id
      join public.roles r on r.id = ur.role_id and r.name = 'admin'
     where au.organization_id = p_organization_id
       and au.is_active
       and au.id <> p_app_user_id;
  exception when others then
    v_notify_error := sqlerrm;
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (
      p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SOLE_APPROVER_NOTIFICATION_FAILED', 'purchase_document', p_purchase_document_id,
      jsonb_build_object('error', v_notify_error)
    );
  end;

  return query select
    p_purchase_document_id, 'VERIFIED'::text, v_verified_at, 'SOLE_APPROVER'::text,
    v_posting.out_status, v_posting.out_posting_id, v_posting.out_posted_line_count, v_posting.out_movement_count,
    v_total, v_inventory_value, v_inventory_line_count, v_expense_line_count;
end;
$$;

revoke all on function public.post_purchase_document_sole_approver(uuid, uuid, uuid, integer, text, text, uuid) from public;
grant execute on function public.post_purchase_document_sole_approver(uuid, uuid, uuid, integer, text, text, uuid) to service_role;

-- ============================================================
-- 5. set_purchase_sole_approver_permission -- Admin-only grant/revoke of
--    the purchase_sole_approver role for one specific app_user. A THIN,
--    single-role variant of set_user_role (20260811100094) -- reuses the
--    same "no application login account" guard (GA039) and "target not
--    found" guard (GA034), but never touches manager/admin role rows and
--    never enforces the "at least one active Admin" rule (irrelevant to
--    this role). Actor authorization (must be an Admin) is enforced by
--    the calling server action via requireAdmin(), exactly like every
--    other admin mutation in this schema -- this function additionally
--    re-derives it here so a forged/direct call with a non-Admin actor id
--    is refused regardless of what called it.
-- ============================================================
create or replace function public.set_purchase_sole_approver_permission(
  p_app_user_id uuid,
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_granted boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_auth_account boolean;
  v_actor_is_admin boolean;
  v_role_id uuid;
begin
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
     where ur.app_user_id = p_actor_app_user_id and ur.organization_id = p_organization_id and r.name = 'admin'
  ) into v_actor_is_admin;

  if not v_actor_is_admin then
    raise exception 'app_user % is not an Admin and cannot grant or revoke this permission', p_actor_app_user_id
      using errcode = 'GA033';
  end if;

  select auth_user_id is not null into v_has_auth_account
    from public.app_users where id = p_app_user_id and organization_id = p_organization_id;
  if not found then
    raise exception 'user % not found in organization %', p_app_user_id, p_organization_id using errcode = 'GA034';
  end if;

  if p_granted and not v_has_auth_account then
    raise exception 'this employee has no application login account -- single-manager posting requires one' using errcode = 'GA039';
  end if;

  select id into v_role_id from public.roles where name = 'purchase_sole_approver';

  if p_granted then
    insert into public.user_roles (app_user_id, role_id, organization_id, granted_by_app_user_id)
    values (p_app_user_id, v_role_id, p_organization_id, p_actor_app_user_id)
    on conflict (app_user_id, role_id) do nothing;
  else
    delete from public.user_roles where app_user_id = p_app_user_id and role_id = v_role_id;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    p_organization_id, p_actor_app_user_id,
    case when p_granted then 'USER_PERMISSION_GRANTED' else 'USER_PERMISSION_REVOKED' end,
    'app_user', p_app_user_id,
    jsonb_build_object('permission', 'purchase_documents.post_without_second_review')
  );
end;
$$;

revoke all on function public.set_purchase_sole_approver_permission(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_purchase_sole_approver_permission(uuid, uuid, uuid, boolean) to service_role;

-- ============================================================
-- 6. search_receiving_queue: one additional output column
--    (out_verification_method) so the manager document list can show a
--    "Single-manager approval" tag -- body+signature replace, same
--    technique as 20260811100099's own change to this function.
-- ============================================================
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
  out_current_verified_revision_number integer,
  out_created_by_app_user_id uuid,
  out_verification_method text
)
language sql
stable
security definer
set search_path = ''
as $$
  with merged as (
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
      pd.created_by_app_user_id,
      pd.verification_method,
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
    left join lateral (
      select de.document_id, de.status as attempt_status, de.requested_at, de.started_at
      from public.document_extractions de
      where de.organization_id = p_organization_id
        and de.document_id = d.id
      order by de.attempt_number desc
      limit 1
    ) la on true
    where d.organization_id = p_organization_id
      and not exists (select 1 from public.document_archives da where da.document_id = d.id)
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
      -- Pushed-down filters (none depend on derived columns):
      and (p_vendor_id is null or coalesce(pd.vendor_id, d.vendor_id) = p_vendor_id)
      and (p_uploaded_by_app_user_id is null or d.uploaded_by_app_user_id = p_uploaded_by_app_user_id)
      and (p_document_type is null or coalesce(pd.document_type, d.declared_document_type) = p_document_type)
      -- Business Document Date: only purchase_documents.document_date, never
      -- Gemini's extracted date -- a row with no recorded business date is
      -- excluded from this filter mode entirely, not silently matched.
      and (
        p_date_type <> 'business'
        or (
          pd.document_date is not null
          and (p_date_from is null or pd.document_date >= p_date_from)
          and (p_date_to is null or pd.document_date <= p_date_to)
        )
      )
      -- Uploaded Date: always documents.created_at.
      and (
        p_date_type = 'business'
        or (
          (p_date_from is null or d.created_at >= p_date_from::timestamptz)
          and (p_date_to is null or d.created_at < (p_date_to + 1)::timestamptz)
        )
      )
  )
  select
    m.document_id, m.original_filename, m.content_type, m.created_at, m.uploaded_by_app_user_id,
    m.purchase_document_id, m.effective_vendor_id, m.effective_document_type,
    m.declared_vendor_id, m.declared_document_type,
    m.document_number, m.document_date, m.computed_status, m.verified_by_app_user_id,
    m.revision_number, m.current_verified_revision_number, m.created_by_app_user_id, m.verification_method
  from merged m
  -- Derived-column filters -- still strictly BEFORE the limit.
  where (p_status is null or m.computed_status = p_status)
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
