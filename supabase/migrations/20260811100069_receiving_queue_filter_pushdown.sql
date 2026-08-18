-- Performance fix for search_receiving_queue -- the second half of the
-- work 20260811100067's indexes started. Body-only replace of the CURRENT
-- definition (20260811100034's 16-column version, revision/archive
-- semantics included -- NOT the original 20260811100028 shape): identical
-- parameters, return shape, and filter semantics (every filter still
-- applies BEFORE the limit), and identical status derivation.
--
-- The previous body computed its merged CTE over EVERY document in the
-- organization on every call -- including a global DISTINCT ON over the
-- org's entire document_extractions history -- and only then filtered.
-- At real volume (docs/PRODUCT.md: ~200 documents/week, and the shared
-- integration-test org already holds 14k+) that exceeded the statement
-- timeout under concurrent load, which surfaced as a (previously silent,
-- now loud) empty Receiving Queue.
--
-- Two structural changes, no semantic ones:
-- 1. Filter pushdown: every predicate that does NOT depend on derived
--    columns (vendor, uploader, document type, both date modes) moves into
--    the base scan, so a filtered query touches only its own small slice.
--    Predicates that DO need derived data (status, text search over the
--    merged document number) stay in the outer query, still before LIMIT.
-- 2. The global latest-attempt CTE becomes a per-document LATERAL probe
--    against document_extractions_org_document_attempt_idx (20260811100067)
--    -- O(1) per candidate row instead of a full-history sort per call.
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
    m.revision_number, m.current_verified_revision_number
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
