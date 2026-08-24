-- V1 Reports closeout -- bug fix, found via live data reconciliation:
-- get_receiving_report's readyToPostCount (20260811100109) counted every
-- VERIFIED document whose posting_status derivation fell into the
-- catch-all 'NOT_POSTED' branch, which included VERIFIED documents with
-- ZERO required inventory lines (nothing to post at all -- e.g. an
-- entirely non-inventory delivery). The Receiving Queue's own UI
-- (receivingStatusPresentation.ts) already correctly guards this with an
-- explicit requiredLineCount > 0 check before ever labeling a row "Ready
-- to Post" -- this RPC had no equivalent guard, so the report's own
-- summary count could overstate how many documents genuinely need
-- posting. Confirmed against real dev data: readyToPostCount reported 2
-- when only 1 document actually had postable inventory lines.
--
-- Fix: a VERIFIED document with zero required lines now gets
-- posting_status = null (excluded from all three counts entirely, the
-- same "nothing to post" treatment the Queue UI already applies), rather
-- than being silently folded into NOT_POSTED.
create or replace function public.get_receiving_report(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_vendor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with docs as (
    select pd.id, pd.status, pd.vendor_id, v.name as vendor_name
    from public.purchase_documents pd
    join public.vendors v on v.id = pd.vendor_id and v.organization_id = p_organization_id
    where pd.organization_id = p_organization_id
      and pd.document_date between p_date_from and p_date_to
      and (p_vendor_id is null or pd.vendor_id = p_vendor_id)
  ),
  posting as (
    select
      d.id,
      case
        when d.status <> 'VERIFIED' then null
        -- Nothing to post at all (e.g. an entirely non-inventory
        -- delivery) -- never counted as "ready to post."
        when agg.required_count is null or agg.required_count = 0 then null
        when agg.posted_count = 0 then 'NOT_POSTED'
        when agg.posted_count < agg.required_count then 'PARTIALLY_POSTED'
        else 'POSTED'
      end as posting_status
    from docs d
    left join lateral (
      select
        count(*) as required_count,
        count(*) filter (where pl.id is not null) as posted_count
      from public.effective_receipts_for_purchase_document(d.id, p_organization_id) er
      join public.receipt_lines rl on rl.receipt_id = er.id
      join public.purchase_document_line_classifications c
        on c.organization_id = p_organization_id
       and c.purchase_document_id = d.id
       and c.line_key = rl.matched_line_key
       and c.status = 'CONFIRMED'
       and c.disposition = 'INVENTORY'
      left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
      where rl.matched_line_key is not null
        and rl.actual_received_package_quantity is not null
        and rl.actual_received_package_quantity > 0
    ) agg on d.status = 'VERIFIED'
  )
  select jsonb_build_object(
    'documentCount', (select count(*) from docs),
    'byStatus', coalesce((
      select jsonb_agg(row) from (select jsonb_build_object('status', status, 'count', count(*)) as row from docs group by status) t
    ), '[]'::jsonb),
    'byVendor', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object('vendorId', vendor_id, 'vendorName', vendor_name, 'count', count(*)) as row
        from docs group by vendor_id, vendor_name order by count(*) desc limit 15
      ) t
    ), '[]'::jsonb),
    'creditLineCount', (
      select count(*) from public.purchase_document_lines pdl
      join docs d on d.id = pdl.purchase_document_id
      where pdl.organization_id = p_organization_id and pdl.line_total < 0
    ),
    'readyToPostCount', (select count(*) from posting where posting_status = 'NOT_POSTED'),
    'partiallyPostedCount', (select count(*) from posting where posting_status = 'PARTIALLY_POSTED'),
    'postedCount', (select count(*) from posting where posting_status = 'POSTED')
  );
$$;

revoke all on function public.get_receiving_report(uuid, date, date, uuid) from public;
grant execute on function public.get_receiving_report(uuid, date, date, uuid) to service_role;
