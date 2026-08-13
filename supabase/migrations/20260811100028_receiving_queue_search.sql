-- Milestone 2A.2 fix: receiving queue search moves entirely into the
-- database, filtering BEFORE any limit is applied.
--
-- The previous implementation (app/lib/documents/receivingQueue.ts) fetched
-- only the newest 200 `documents` rows, then applied vendor/document-type/
-- status/business-date/text-search filters in JavaScript afterward -- a
-- real match older than those 200 rows could never surface, no matter how
-- narrow the filter. This function does the same "prefer purchase_documents'
-- corrected data, else fall back to the documents-level intake declaration"
-- merge and the same workflow-status derivation that documentStatus.ts
-- already does in TS, but does it once, in SQL, so every filter predicate
-- (including status and business-date, which need the merged/derived
-- columns) can be applied in the WHERE clause before LIMIT -- not after.
--
-- Read-only, security definer + search_path='' (same convention as every
-- other RPC in this milestone), service_role only. Every table reference is
-- schema-qualified. Display-name resolution (vendor/uploader/verifier
-- names) deliberately stays in the TS caller (app/lib/documents/
-- receivingQueue.ts) -- it's a cheap batched lookup against an
-- already-filtered, already-bounded result set, not something that needs
-- to live in this function.
--
-- The PROCESSING/STALLED staleness threshold below (5 minutes) mirrors
-- app/lib/documents/staleExtraction.ts's STALE_EXTRACTION_THRESHOLD_MS --
-- kept in sync by hand since it's a display heuristic (not authoritative
-- business data) and this is the one place it's duplicated into SQL.
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
  out_verified_by_app_user_id uuid
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
    left join public.purchase_documents pd
      on pd.source_document_id = d.id and pd.organization_id = d.organization_id
    left join latest_attempt la on la.document_id = d.id
    where d.organization_id = p_organization_id
  )
  select
    m.document_id, m.original_filename, m.content_type, m.created_at, m.uploaded_by_app_user_id,
    m.purchase_document_id, m.effective_vendor_id, m.effective_document_type,
    m.declared_vendor_id, m.declared_document_type,
    m.document_number, m.document_date, m.computed_status, m.verified_by_app_user_id
  from merged m
  where (p_vendor_id is null or m.effective_vendor_id = p_vendor_id)
    and (p_uploaded_by_app_user_id is null or m.uploaded_by_app_user_id = p_uploaded_by_app_user_id)
    and (p_status is null or m.computed_status = p_status)
    and (p_document_type is null or m.effective_document_type = p_document_type)
    -- Business Document Date: only purchase_documents.document_date, never
    -- Gemini's extracted date -- a row with no recorded business date is
    -- excluded from this filter mode entirely, not silently matched.
    and (
      p_date_type <> 'business'
      or (
        m.document_date is not null
        and (p_date_from is null or m.document_date >= p_date_from)
        and (p_date_to is null or m.document_date <= p_date_to)
      )
    )
    -- Uploaded Date: always documents.created_at.
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
