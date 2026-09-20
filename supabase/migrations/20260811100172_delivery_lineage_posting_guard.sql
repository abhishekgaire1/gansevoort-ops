-- Mandatory database-level delivery-lineage guard (GA080), enforced inside the
-- posting transaction so NO posting path can bypass it -- normal posting,
-- sole-approver posting, additional-delivery posting, or a direct RPC call.
--
-- It fires as a BEFORE INSERT trigger on the postings header (the same non-
-- bypassable point the price guard uses), locks every receipt of the document
-- until the posting transaction commits/rolls back, and rejects AMBIGUOUS
-- delivery lineage with GA080 -- independent of price review (works with no
-- price history and no material price change). It never blocks multiple
-- DISTINCT legitimate delivery events (delivery_event_id), which posting sums.
--
-- Authoritative ambiguity definition (mirrors the TypeScript classifier, but
-- the DATABASE owns posting-critical truth): among the effective (non-
-- superseded) receipts that contribute a matched inventory line --
--   * 0 or 1 effective delivery                        -> unambiguous
--   * many, all with DISTINCT non-null delivery_event_id -> unambiguous (sum)
--   * any null, or a repeated event id                  -> AMBIGUOUS (GA080)
-- Identity decides, never matching quantities.

create or replace function public.assert_delivery_lineage_unambiguous(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_distinct integer;
  v_null_count integer;
begin
  -- Lock every receipt of this document (FOR NO KEY UPDATE, deterministic
  -- order) so lineage cannot change between this check and the posting loop.
  -- Held until the posting transaction commits or rolls back.
  perform 1
    from public.receipts
   where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id
   order by id
   for no key update;

  with eff as (
    select er.id, er.delivery_event_id
      from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
     where exists (
       select 1
         from public.receipt_lines rl
        where rl.receipt_id = er.id
          and rl.organization_id = p_organization_id
          and rl.matched_line_key is not null
     )
  )
  select count(*), count(distinct delivery_event_id), count(*) filter (where delivery_event_id is null)
    into v_count, v_distinct, v_null_count
    from eff;

  if v_count <= 1 then
    return; -- single delivery (or single correction chain): unambiguous.
  end if;

  if v_null_count > 0 then
    raise exception 'This invoice has multiple recorded deliveries whose delivery records cannot be automatically distinguished. Review the recorded deliveries before posting.'
      using errcode = 'GA080';
  end if;

  -- No nulls here, so count(distinct) counts the non-null event ids; a repeat
  -- means two current versions claim the same physical delivery.
  if v_distinct <> v_count then
    raise exception 'This invoice has conflicting current versions of the same recorded delivery. Review the recorded deliveries before posting.'
      using errcode = 'GA080';
  end if;
end;
$$;

revoke all on function public.assert_delivery_lineage_unambiguous(uuid, uuid) from public;
grant execute on function public.assert_delivery_lineage_unambiguous(uuid, uuid) to service_role;

create or replace function public.trg_assert_delivery_lineage_before_posting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_delivery_lineage_unambiguous(new.purchase_document_id, new.organization_id);
  return new;
end;
$$;

-- Runs on EVERY posting path (the header insert is the single choke point).
create trigger assert_delivery_lineage_before_posting
  before insert on public.purchase_document_inventory_postings
  for each row execute function public.trg_assert_delivery_lineage_before_posting();
