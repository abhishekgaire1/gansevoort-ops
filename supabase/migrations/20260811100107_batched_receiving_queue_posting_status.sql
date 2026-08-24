-- V1 Ready-to-Post queue gap fix. The VERIFIED detail page has always
-- been able to derive posting status via
-- purchase_document_inventory_posting_status (20260811100064), but that
-- RPC takes exactly one purchase_document_id -- the Receiving Queue,
-- which renders up to QUEUE_RESULT_LIMIT (200) rows at once, had NO way
-- to show posting status without either an N+1 loop (one RPC call per
-- VERIFIED row) or not showing it at all, which is what the queue did:
-- every VERIFIED document read as a flat "Verified · View Invoice →",
-- with no way to tell which ones still needed "Post to Inventory"
-- without opening each one individually.
--
-- This is the SAME EXACT derivation logic as the single-document RPC --
-- required lines are effective receipt lines representing real physical
-- inventory (CONFIRMED INVENTORY classification, received quantity > 0),
-- status is NEVER inferred from purchase_document.status or receipt
-- existence, only from actual posting records -- just batched over an
-- array of document ids in ONE round trip via a LATERAL join against the
-- same effective_receipts_for_purchase_document(...) function the
-- single-document RPC already calls, rather than duplicating its receipt-
-- correction-aware "effective receipt" resolution logic.
create function public.get_purchase_documents_inventory_posting_status(
  p_organization_id uuid,
  p_purchase_document_ids uuid[]
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_required_line_count integer,
  out_posted_line_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with doc_ids as (
    select distinct unnest(p_purchase_document_ids) as purchase_document_id
  ),
  required as (
    select
      d.purchase_document_id,
      rl.id,
      (pl.id is not null) as posted
    from doc_ids d
    cross join lateral public.effective_receipts_for_purchase_document(d.purchase_document_id, p_organization_id) er
    join public.receipt_lines rl on rl.receipt_id = er.id
    join public.purchase_document_line_classifications c
      on c.organization_id = p_organization_id
     and c.purchase_document_id = d.purchase_document_id
     and c.line_key = rl.matched_line_key
     and c.status = 'CONFIRMED'
     and c.disposition = 'INVENTORY'
    left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
    where rl.matched_line_key is not null
      and rl.actual_received_package_quantity is not null
      and rl.actual_received_package_quantity > 0
  ),
  aggregated as (
    select
      purchase_document_id,
      count(*) as required_count,
      count(*) filter (where posted) as posted_count
    from required
    group by purchase_document_id
  )
  select
    d.purchase_document_id,
    case
      when a.required_count is null or a.posted_count = 0 then 'NOT_POSTED'
      when a.posted_count < a.required_count then 'PARTIALLY_POSTED'
      else 'POSTED'
    end,
    coalesce(a.required_count, 0)::integer,
    coalesce(a.posted_count, 0)::integer
  from doc_ids d
  left join aggregated a on a.purchase_document_id = d.purchase_document_id;
$$;

revoke all on function public.get_purchase_documents_inventory_posting_status(uuid, uuid[]) from public;
grant execute on function public.get_purchase_documents_inventory_posting_status(uuid, uuid[]) to service_role;
