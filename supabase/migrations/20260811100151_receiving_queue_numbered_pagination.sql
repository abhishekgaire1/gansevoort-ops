-- Receiving Queue: numbered (desktop-style) pagination -- replaces the
-- short-lived keyset cursor from 20260811100150 with offset paging plus
-- a window total count, per explicit operator direction ("proper
-- pagination like desktop apps", i.e. numbered page links, Previous/
-- Next, and "Showing X-Y of Z" -- not an appending Load More).
--
-- WHY OFFSET IS THE RIGHT TOOL HERE (after 100149/100150 argued for
-- keyset elsewhere): numbered pages require random access -- "jump to
-- page 4" -- which a keyset cursor structurally cannot do, and they
-- require the filtered TOTAL, which keyset never produces. Offset's
-- classic weaknesses don't bite at this table's scale and shape: the
-- queue is a bounded operational document list (not an unbounded
-- ledger), every page still passes through the same filter-before-limit
-- WHERE, the (created_at desc, document_id desc) tiebreaker ordering
-- from 100150 keeps page boundaries deterministic, and PostgREST's row
-- cap is irrelevant because each call returns at most one clamped page.
--
-- out_total_count is count(*) over () -- computed AFTER all filters
-- (including p_statuses and p_query) and BEFORE limit/offset, so it is
-- the exact filtered total every returned row agrees on. A page beyond
-- the end returns zero rows (and thus no count) -- the TS wrapper
-- clamps by refetching page one in that case.
--
-- The keyset parameters (p_before_created_at/p_before_document_id) are
-- REMOVED, not kept dormant: their only caller was the Load More path
-- deleted in this same change, and dead RPC parameters are a standing
-- source of confusion. p_status (single, dashboard) and p_statuses
-- (tab set) are unchanged.
drop function if exists public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer, text[], timestamptz, uuid);

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
  p_limit integer default 200,
  p_statuses text[] default null,
  p_offset integer default 0
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
  out_verification_method text,
  out_total_count bigint
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
    m.revision_number, m.current_verified_revision_number, m.created_by_app_user_id, m.verification_method,
    count(*) over () as total_count
  from merged m
  -- Derived-column filters -- still strictly BEFORE the limit, so the
  -- window count above is the exact filtered total.
  where (p_status is null or m.computed_status = p_status)
    and (p_statuses is null or m.computed_status = any(p_statuses))
    and (
      p_query is null or btrim(p_query) = ''
      or m.original_filename ilike '%' || p_query || '%'
      or m.document_number ilike '%' || p_query || '%'
    )
  order by m.created_at desc, m.document_id desc
  limit greatest(least(coalesce(p_limit, 200), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer, text[], integer) from public;
grant execute on function public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer, text[], integer) to service_role;
