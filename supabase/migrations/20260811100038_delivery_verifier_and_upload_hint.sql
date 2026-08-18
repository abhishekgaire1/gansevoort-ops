-- Milestone 2A.3 (part 4 of 8): delivery verifier capture + upload
-- disposition hint.
--
-- The delivery verifier is captured EXACTLY ONCE, authoritatively, at
-- upload -- never re-asked at receiving time. documents.
-- delivery_verified_by_employee_id references EMPLOYEES, not app_users:
-- the manager who physically verified a delivery writes their name on the
-- back of the invoice and never needs to authenticate with the app at all;
-- only the invoice-entry manager (an authenticated app_user) needs to sign
-- in to record that fact. This mirrors the existing employees-vs-app_users
-- split already used by default_station_id/employee kiosk config -- an
-- employee row never requires a corresponding app_users/PIN row to exist.
--
-- documents is fully append-only (zero exceptions, confirmed by its own
-- 20260811100018 migration and reinforced by 20260811100034's correction
-- of an earlier mistake in this exact codebase) -- both new columns are
-- set exactly once, at INSERT, by finalize_document_upload, and NEVER
-- updated afterward. Corrections to a mistakenly-selected verifier are
-- captured as new rows in the companion document_delivery_verifier_
-- corrections table below, never as a mutation of documents itself.

alter table public.documents
  add column declared_disposition_hint text,
  add column delivery_verified_by_employee_id uuid;

alter table public.documents
  add constraint documents_declared_disposition_hint_check
  check (declared_disposition_hint is null or declared_disposition_hint in ('INVENTORY_ONLY', 'NON_INVENTORY_ONLY', 'BOTH', 'NOT_SURE'));

alter table public.documents
  add constraint documents_delivery_verifier_org_fk foreign key (delivery_verified_by_employee_id, organization_id)
    references public.employees (id, organization_id);

-- finalize_document_upload gains two new OPTIONAL trailing parameters.
-- Valid via CREATE OR REPLACE FUNCTION (not drop-and-recreate) specifically
-- because they're optional/defaulted -- Postgres treats an added trailing
-- parameter with a default as a true replace of the same function
-- identity, not a new ambiguous overload, as long as every existing
-- (named-parameter) caller that omits them keeps working unchanged. This
-- is the exact technique already proven in this codebase by
-- 20260811100031 (submit_purchase_document_for_verification/
-- verify_purchase_document gaining optional p_header/p_lines), which is a
-- closer precedent than 20260811100022/20260811100024's drop-and-recreate
-- -- those were adding REQUIRED parameters, a genuinely different case.
create or replace function public.finalize_document_upload(
  p_document_id uuid,
  p_organization_id uuid,
  p_uploaded_by_app_user_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_content_type text,
  p_byte_size bigint,
  p_file_sha256 text,
  p_provider text,
  p_model text,
  p_vendor_id uuid,
  p_declared_document_type text,
  p_declared_disposition_hint text default null,
  p_delivery_verified_by_employee_id uuid default null
)
returns table (
  out_document_id uuid,
  out_attempt_id uuid,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_have_existing boolean;
  v_attempt_id uuid;
  v_replayed boolean;
begin
  select d.organization_id, d.storage_path, d.file_sha256, d.byte_size, d.content_type,
         d.vendor_id, d.declared_document_type, d.declared_disposition_hint, d.delivery_verified_by_employee_id
    into v_existing
    from public.documents d
   where d.id = p_document_id;
  v_have_existing := found;

  if not v_have_existing then
    if p_declared_document_type is null then
      raise exception 'declared_document_type is required for a new document upload';
    end if;

    if not exists (
      select 1 from public.vendors v
       where v.id = p_vendor_id
         and v.organization_id = p_organization_id
         and v.is_active
    ) then
      raise exception 'vendor_id % is not an active vendor in organization %', p_vendor_id, p_organization_id
        using errcode = 'GA005';
    end if;

    if p_delivery_verified_by_employee_id is not null and not exists (
      select 1 from public.employees e
       where e.id = p_delivery_verified_by_employee_id
         and e.organization_id = p_organization_id
         and e.status = 'active'
    ) then
      raise exception 'delivery_verified_by_employee_id % is not an active employee in organization %', p_delivery_verified_by_employee_id, p_organization_id
        using errcode = 'GA008';
    end if;

    begin
      insert into public.documents as d (
        id, organization_id, uploaded_by_app_user_id, storage_path,
        original_filename, content_type, byte_size, file_sha256,
        vendor_id, declared_document_type, declared_disposition_hint, delivery_verified_by_employee_id
      ) values (
        p_document_id, p_organization_id, p_uploaded_by_app_user_id, p_storage_path,
        p_original_filename, p_content_type, p_byte_size, p_file_sha256,
        p_vendor_id, p_declared_document_type, p_declared_disposition_hint, p_delivery_verified_by_employee_id
      );
      v_replayed := false;
    exception when unique_violation then
      select d.organization_id, d.storage_path, d.file_sha256, d.byte_size, d.content_type,
             d.vendor_id, d.declared_document_type, d.declared_disposition_hint, d.delivery_verified_by_employee_id
        into v_existing
        from public.documents d
       where d.id = p_document_id;

      if not found then
        raise exception 'document_id % conflicted on insert but no matching document was found on retry', p_document_id;
      end if;

      v_have_existing := true;
    end;
  end if;

  if v_have_existing then
    if v_existing.organization_id is distinct from p_organization_id
       or v_existing.storage_path is distinct from p_storage_path
       or v_existing.file_sha256 is distinct from p_file_sha256
       or v_existing.byte_size is distinct from p_byte_size
       or v_existing.content_type is distinct from p_content_type
       or v_existing.vendor_id is distinct from p_vendor_id
       or v_existing.declared_document_type is distinct from p_declared_document_type
       or v_existing.declared_disposition_hint is distinct from p_declared_disposition_hint
       or v_existing.delivery_verified_by_employee_id is distinct from p_delivery_verified_by_employee_id
    then
      raise exception 'document_id % already exists with different file identity', p_document_id
        using errcode = 'GA001';
    end if;

    v_replayed := true;
  end if;

  select de.id into v_attempt_id
    from public.document_extractions de
   where de.document_id = p_document_id
     and de.attempt_number = 1;

  if not found then
    begin
      insert into public.document_extractions as de (
        organization_id, document_id, attempt_number, provider, model, status
      ) values (
        p_organization_id, p_document_id, 1, p_provider, p_model, 'PENDING'
      ) returning de.id into v_attempt_id;
    exception when unique_violation then
      select de.id into v_attempt_id
        from public.document_extractions de
       where de.document_id = p_document_id
         and de.attempt_number = 1;

      if not found then
        raise exception 'attempt 1 for document_id % conflicted on insert but no matching attempt was found on retry', p_document_id;
      end if;
    end;
  end if;

  return query select p_document_id as out_document_id, v_attempt_id as out_attempt_id, v_replayed as out_replayed;
end;
$$;

-- ============================================================
-- Correctable delivery-verifier corrections (companion append-only table)
-- ============================================================
-- documents cannot be widened further (it must stay unconditionally
-- append-only) -- a correction to a mistakenly-selected verifier is a NEW
-- fact recorded here, exactly the same pattern already used by
-- document_archives for the same underlying reason.
create table public.document_delivery_verifier_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  document_id uuid not null,
  previous_employee_id uuid,
  corrected_employee_id uuid not null,
  corrected_by_app_user_id uuid not null,
  reason text,
  corrected_at timestamptz not null default now(),
  constraint document_delivery_verifier_corrections_document_org_fk foreign key (document_id, organization_id)
    references public.documents (id, organization_id),
  constraint document_delivery_verifier_corrections_previous_employee_org_fk foreign key (previous_employee_id, organization_id)
    references public.employees (id, organization_id),
  constraint document_delivery_verifier_corrections_corrected_employee_org_fk foreign key (corrected_employee_id, organization_id)
    references public.employees (id, organization_id),
  constraint document_delivery_verifier_corrections_actor_org_fk foreign key (corrected_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create index document_delivery_verifier_corrections_document_idx
  on public.document_delivery_verifier_corrections (document_id, corrected_at desc);

create trigger document_delivery_verifier_corrections_forbid_update
  before update on public.document_delivery_verifier_corrections
  for each row execute function public.forbid_update_delete();

create trigger document_delivery_verifier_corrections_forbid_delete
  before delete on public.document_delivery_verifier_corrections
  for each row execute function public.forbid_update_delete();

alter table public.document_delivery_verifier_corrections enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- Current effective verifier = the most recent correction's
-- corrected_employee_id if one exists, else the original declared value.
create or replace function public.current_document_delivery_verifier_employee_id(
  p_document_id uuid,
  p_organization_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select c.corrected_employee_id
        from public.document_delivery_verifier_corrections c
       where c.document_id = p_document_id
         and c.organization_id = p_organization_id
       order by c.corrected_at desc
       limit 1
    ),
    (
      select d.delivery_verified_by_employee_id
        from public.documents d
       where d.id = p_document_id
         and d.organization_id = p_organization_id
    )
  );
$$;

revoke all on function public.current_document_delivery_verifier_employee_id(uuid, uuid) from public;
grant execute on function public.current_document_delivery_verifier_employee_id(uuid, uuid) to service_role;
