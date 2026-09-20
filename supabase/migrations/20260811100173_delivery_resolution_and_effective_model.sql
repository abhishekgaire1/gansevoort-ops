-- Append-only delivery-resolution model + one authoritative effective-delivery
-- definition consumed by every posting/price/readiness path.
--
-- Builds on 100171 (delivery_event_id) and 100172 (GA080 header guard). A
-- manager resolves an AMBIGUOUS historical document (multiple effective delivery
-- lineages with null/duplicate event ids) by declaring, for every current
-- effective delivery receipt, whether it is a distinct physical delivery
-- (CANONICAL) or a DUPLICATE of a retained one. Resolutions are append-only and
-- never touch receipts, movements, balances, or prices.

-- ============================================================
-- 1. Append-only resolution table
-- ============================================================
create table public.delivery_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  resolution_version integer not null,
  -- Hash of the effective delivery-receipt set at resolution time; a new
  -- receipt/correction changes it, invalidating this (now stale) resolution.
  fingerprint text not null,
  resolved_by_app_user_id uuid not null,
  reason text not null,
  -- [{ "receiptId": uuid, "decision": "CANONICAL"|"DUPLICATE",
  --    "duplicateOfReceiptId": uuid|null }] -- one entry per current effective
  -- delivery receipt (validated in the RPC).
  decisions jsonb not null,
  before_quantity jsonb,
  after_quantity jsonb,
  created_at timestamptz not null default now(),
  constraint delivery_resolutions_pd_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id),
  constraint delivery_resolutions_actor_org_fk foreign key (resolved_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint delivery_resolutions_doc_version_key unique (purchase_document_id, resolution_version),
  constraint delivery_resolutions_reason_check check (btrim(reason) <> '')
);

create index delivery_resolutions_doc_idx on public.delivery_resolutions (organization_id, purchase_document_id, resolution_version desc);

alter table public.delivery_resolutions enable row level security;

create trigger delivery_resolutions_forbid_update
  before update on public.delivery_resolutions
  for each row execute function public.forbid_update_delete();
create trigger delivery_resolutions_forbid_delete
  before delete on public.delivery_resolutions
  for each row execute function public.forbid_update_delete();

-- ============================================================
-- 2. Effective-delivery fingerprint (stable hash of the current lineage)
-- ============================================================
create or replace function public.purchase_document_delivery_fingerprint(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(md5(string_agg(er.id::text, ',' order by er.id)), '')
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
   where exists (
     select 1 from public.receipt_lines rl
      where rl.receipt_id = er.id and rl.organization_id = p_organization_id and rl.matched_line_key is not null
   );
$$;

revoke all on function public.purchase_document_delivery_fingerprint(uuid, uuid) from public;
grant execute on function public.purchase_document_delivery_fingerprint(uuid, uuid) to service_role;

-- ============================================================
-- 3. The current (latest, non-stale) resolution for a document, if any.
-- ============================================================
create or replace function public.current_delivery_resolution(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns public.delivery_resolutions
language sql
stable
security definer
set search_path = ''
as $$
  select dr.*
    from public.delivery_resolutions dr
   where dr.organization_id = p_organization_id
     and dr.purchase_document_id = p_purchase_document_id
     and dr.fingerprint = public.purchase_document_delivery_fingerprint(p_purchase_document_id, p_organization_id)
   order by dr.resolution_version desc
   limit 1;
$$;

revoke all on function public.current_delivery_resolution(uuid, uuid) from public;
grant execute on function public.current_delivery_resolution(uuid, uuid) to service_role;

-- ============================================================
-- 4. THE authoritative effective-delivery receipts: the receipt ids that
--    CONTRIBUTE quantity, after supersession + delivery_event_id + a valid
--    resolution's duplicate exclusions. One row per contributing receipt.
-- ============================================================
create or replace function public.purchase_document_effective_delivery_receipts(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns table (out_receipt_id uuid, out_delivery_event_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with eff as (
    select er.id, er.delivery_event_id
      from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
     where exists (
       select 1 from public.receipt_lines rl
        where rl.receipt_id = er.id and rl.organization_id = p_organization_id and rl.matched_line_key is not null
     )
  ),
  res as (
    select decisions from public.current_delivery_resolution(p_purchase_document_id, p_organization_id)
  )
  select eff.id, eff.delivery_event_id
    from eff
   where not exists (
     -- Exclude receipts a valid resolution marked as DUPLICATE.
     select 1
       from res, jsonb_array_elements(res.decisions) d
      where (d->>'receiptId')::uuid = eff.id
        and d->>'decision' = 'DUPLICATE'
   );
$$;

revoke all on function public.purchase_document_effective_delivery_receipts(uuid, uuid) from public;
grant execute on function public.purchase_document_effective_delivery_receipts(uuid, uuid) to service_role;

-- ============================================================
-- 5. Authoritative delivery status: SINGLE | ADDITIONAL | RESOLVED | AMBIGUOUS.
-- ============================================================
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
  v_has_resolution boolean;
begin
  select count(*), count(distinct out_delivery_event_id), count(*) filter (where out_delivery_event_id is null)
    into v_count, v_distinct, v_null
    from public.purchase_document_effective_delivery_receipts(p_purchase_document_id, p_organization_id);

  v_has_resolution := (public.current_delivery_resolution(p_purchase_document_id, p_organization_id)).id is not null;

  if v_count <= 1 then
    return 'SINGLE';
  end if;
  -- More than one CONTRIBUTING delivery remains.
  if v_null > 0 or v_distinct <> v_count then
    -- Ambiguous unless a valid resolution has explicitly declared these the
    -- retained distinct physical deliveries.
    if v_has_resolution then
      return 'RESOLVED';
    end if;
    return 'AMBIGUOUS';
  end if;
  -- All contributing deliveries have distinct non-null event ids.
  if v_has_resolution then
    return 'RESOLVED';
  end if;
  return 'ADDITIONAL';
end;
$$;

revoke all on function public.purchase_document_delivery_status(uuid, uuid) from public;
grant execute on function public.purchase_document_delivery_status(uuid, uuid) to service_role;

-- ============================================================
-- 6. GA080 guard now delegates to the shared status (agrees by construction).
--    Still locks all receipts of the document until commit/rollback.
-- ============================================================
create or replace function public.assert_delivery_lineage_unambiguous(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
    from public.receipts
   where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id
   order by id
   for no key update;

  if public.purchase_document_delivery_status(p_purchase_document_id, p_organization_id) = 'AMBIGUOUS' then
    raise exception 'This invoice has multiple recorded deliveries whose delivery records cannot be automatically distinguished. Review the recorded deliveries before posting.'
      using errcode = 'GA080';
  end if;
end;
$$;

revoke all on function public.assert_delivery_lineage_unambiguous(uuid, uuid) from public;
grant execute on function public.assert_delivery_lineage_unambiguous(uuid, uuid) to service_role;
