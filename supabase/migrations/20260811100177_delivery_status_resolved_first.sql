-- Fix: purchase_document_delivery_status must report RESOLVED whenever a valid
-- (non-stale) manager resolution exists, so the GA080 guard allows posting and
-- Step 3 shows a resolved state. Without this, a duplicate resolution collapsed
-- to one contributing delivery read as SINGLE, and a separate-delivery
-- resolution (distinct physical deliveries that are still null-event legacy)
-- read as AMBIGUOUS and stayed blocked. A stale resolution is already excluded
-- by current_delivery_resolution (fingerprint), so it correctly falls back to
-- AMBIGUOUS. No-resolution behavior is unchanged.
create or replace function public.purchase_document_delivery_status(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_distinct integer;
  v_null integer;
begin
  -- A valid manager resolution settles the lineage regardless of null event ids.
  if (public.current_delivery_resolution(p_purchase_document_id, p_organization_id)).id is not null then
    return 'RESOLVED';
  end if;

  select count(*), count(distinct out_delivery_event_id), count(*) filter (where out_delivery_event_id is null)
    into v_count, v_distinct, v_null
    from public.purchase_document_effective_delivery_receipts(p_purchase_document_id, p_organization_id);

  if v_count <= 1 then
    return 'SINGLE';
  end if;
  if v_null > 0 or v_distinct <> v_count then
    return 'AMBIGUOUS';
  end if;
  return 'ADDITIONAL';
end;
$$;

revoke all on function public.purchase_document_delivery_status(uuid, uuid) from public;
grant execute on function public.purchase_document_delivery_status(uuid, uuid) to service_role;
