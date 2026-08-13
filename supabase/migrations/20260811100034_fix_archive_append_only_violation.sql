-- Corrects a design mistake in 20260811100033, caught by its own
-- regression test before this was ever manually tested: `documents` is
-- deliberately fully append-only, reusing the same forbid_update_delete()
-- trigger as inventory_movements/audit_events with NO carved-out
-- exceptions -- confirmed by that table's own 20260811100018 migration
-- comment ("Fully append-only... documents represents immutable
-- source-document facts only"). 100033 added archived_at/
-- archived_by_app_user_id/archive_reason as UPDATE-able columns on
-- `documents` and had archive_document UPDATE them directly, which the
-- trigger correctly rejected: "documents is an append-only historical
-- table; UPDATE is not permitted".
--
-- This project's established pattern (already used for `documents` having
-- no document_type column, deriving it instead from document_extractions)
-- is: never widen an append-only table's mutability surface, even for one
-- "convenience" column -- derive it from a related table instead. Fixed
-- here by dropping the three columns 100033 added (they hold no data --
-- archive_document has never successfully written to them) and adding a
-- new, small `document_archives` table: one append-only row per archived
-- document, itself guarded by the same forbid_update_delete() trigger.
-- `documents` itself is completely unchanged by this migration.

alter table public.documents
  drop column archived_at,
  drop column archived_by_app_user_id,
  drop column archive_reason;

create table public.document_archives (
  document_id uuid primary key,
  organization_id uuid not null,
  archived_by_app_user_id uuid not null,
  archive_reason text,
  archived_at timestamptz not null default now(),
  constraint document_archives_document_org_fk foreign key (document_id, organization_id)
    references public.documents (id, organization_id)
);

create trigger document_archives_forbid_update
  before update on public.document_archives
  for each row execute function public.forbid_update_delete();

create trigger document_archives_forbid_delete
  before delete on public.document_archives
  for each row execute function public.forbid_update_delete();

alter table public.document_archives enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

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

  if exists (select 1 from public.document_archives where document_id = p_document_id) then
    raise exception 'document % could not be archived: already archived', p_document_id
      using errcode = 'GA002';
  end if;

  insert into public.document_archives (document_id, organization_id, archived_by_app_user_id, archive_reason)
  values (p_document_id, p_organization_id, p_app_user_id, p_reason)
  returning archived_at into v_archived_at;

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

-- search_receiving_queue: archived-check now derives from document_archives
-- instead of a documents.archived_at column. Same signature/return shape,
-- CREATE OR REPLACE is sufficient.
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
