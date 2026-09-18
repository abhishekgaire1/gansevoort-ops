-- Durable, auditable acknowledgment of a SIGNIFICANT vendor-aware price
-- change on an invoice line (>= 20% normalized base-unit change; see
-- app/lib/purchasing/priceReviewPolicy.ts).
--
-- WHY a new structure: the price comparison itself is derived read-only
-- from already-authoritative posted price history (get_inventory_item_
-- price_history, 20260811100106) and the current draft line -- nothing
-- durable records that a manager reviewed a large change. audit_events is
-- append-only and cannot be efficiently queried as "is THIS line's CURRENT
-- comparison acknowledged?", and it cannot be invalidated when an input
-- changes. So this adds a small mutable per-line acknowledgment keyed by a
-- fingerprint of the exact comparison inputs: any change to quantity,
-- amount, currency, item match, vendor/SKU, package, conversion, received/
-- measured quantity, or the comparable prior event yields a new
-- fingerprint, so a stale acknowledgment no longer matches and re-review is
-- required. The acknowledgment records only that a review happened -- it
-- never alters the invoice amount, vendor package, inventory quantity, or
-- any historical price event.

create table public.price_change_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  line_key uuid not null,
  inventory_item_id uuid not null,
  vendor_id uuid not null,
  vendor_sku text,
  currency text,
  previous_purchase_document_id uuid,
  previous_unit_cost numeric not null,
  current_unit_cost numeric not null,
  delta_pct numeric not null,
  direction text not null check (direction in ('increase', 'decrease')),
  base_unit_code text,
  normalized_base_quantity numeric,
  -- Stable fingerprint of the comparison inputs (priceComparisonFingerprint):
  -- an acknowledgment is valid only while this still matches the freshly
  -- recomputed comparison.
  fingerprint text not null,
  actor_app_user_id uuid not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Organization isolation: the document must belong to the same org.
  constraint price_ack_document_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id) on delete cascade,
  -- Exactly one current acknowledgment per invoice line -- upsert target,
  -- so repeated clicks never create duplicate records (idempotent).
  constraint price_ack_document_line_key unique (purchase_document_id, line_key)
);

create index price_change_acknowledgments_org_doc_idx
  on public.price_change_acknowledgments (organization_id, purchase_document_id);

alter table public.price_change_acknowledgments enable row level security;

-- Idempotent acknowledgment upsert. Repeated calls for the same line update
-- the single row in place (never a duplicate). Writes an audit event only
-- when the acknowledged fingerprint actually changes, so re-clicking the
-- same review is a true no-op in the audit trail.
create or replace function public.acknowledge_price_change(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_inventory_item_id uuid,
  p_vendor_id uuid,
  p_vendor_sku text,
  p_currency text,
  p_previous_purchase_document_id uuid,
  p_previous_unit_cost numeric,
  p_current_unit_cost numeric,
  p_delta_pct numeric,
  p_direction text,
  p_base_unit_code text,
  p_normalized_base_quantity numeric,
  p_fingerprint text,
  p_note text default null
)
returns table (out_acknowledgment_id uuid, out_fingerprint text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_org uuid;
  v_existing_fingerprint text;
  v_id uuid;
begin
  select organization_id into v_doc_org from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;
  if v_doc_org is null then
    raise exception 'purchase_document % not found in organization %', p_purchase_document_id, p_organization_id using errcode = 'GA054';
  end if;
  if p_direction not in ('increase', 'decrease') then
    raise exception 'invalid price direction %', p_direction using errcode = 'GA033';
  end if;
  if p_fingerprint is null or btrim(p_fingerprint) = '' then
    raise exception 'a comparison fingerprint is required' using errcode = 'GA033';
  end if;

  select fingerprint into v_existing_fingerprint from public.price_change_acknowledgments
   where purchase_document_id = p_purchase_document_id and line_key = p_line_key;

  insert into public.price_change_acknowledgments (
    organization_id, purchase_document_id, line_key, inventory_item_id, vendor_id, vendor_sku, currency,
    previous_purchase_document_id, previous_unit_cost, current_unit_cost, delta_pct, direction,
    base_unit_code, normalized_base_quantity, fingerprint, actor_app_user_id, note
  ) values (
    p_organization_id, p_purchase_document_id, p_line_key, p_inventory_item_id, p_vendor_id, p_vendor_sku, p_currency,
    p_previous_purchase_document_id, p_previous_unit_cost, p_current_unit_cost, p_delta_pct, p_direction,
    p_base_unit_code, p_normalized_base_quantity, p_fingerprint, p_actor_app_user_id, nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (purchase_document_id, line_key) do update set
    inventory_item_id = excluded.inventory_item_id,
    vendor_id = excluded.vendor_id,
    vendor_sku = excluded.vendor_sku,
    currency = excluded.currency,
    previous_purchase_document_id = excluded.previous_purchase_document_id,
    previous_unit_cost = excluded.previous_unit_cost,
    current_unit_cost = excluded.current_unit_cost,
    delta_pct = excluded.delta_pct,
    direction = excluded.direction,
    base_unit_code = excluded.base_unit_code,
    normalized_base_quantity = excluded.normalized_base_quantity,
    fingerprint = excluded.fingerprint,
    actor_app_user_id = excluded.actor_app_user_id,
    note = excluded.note,
    updated_at = now()
  returning id into v_id;

  -- Audit only a genuinely new/changed acknowledgment (idempotent re-clicks
  -- of the same fingerprint add no audit noise).
  if v_existing_fingerprint is distinct from p_fingerprint then
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (
      p_organization_id, p_actor_app_user_id, 'PRICE_CHANGE_ACKNOWLEDGED', 'purchase_document_line', p_purchase_document_id,
      jsonb_build_object(
        'lineKey', p_line_key, 'inventoryItemId', p_inventory_item_id, 'vendorId', p_vendor_id, 'vendorSku', p_vendor_sku,
        'currency', p_currency, 'previousUnitCost', p_previous_unit_cost, 'currentUnitCost', p_current_unit_cost,
        'deltaPct', p_delta_pct, 'direction', p_direction, 'fingerprint', p_fingerprint, 'note', nullif(btrim(coalesce(p_note, '')), '')
      )
    );
  end if;

  return query select v_id, p_fingerprint;
end;
$$;

revoke all on function public.acknowledge_price_change(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, numeric, numeric, numeric, text, text, numeric, text, text) from public;
grant execute on function public.acknowledge_price_change(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, numeric, numeric, numeric, text, text, numeric, text, text) to service_role;

-- Read the current acknowledgments for a document (org-scoped), so the
-- server can fold them into the per-line price-review state.
create or replace function public.list_price_change_acknowledgments(
  p_organization_id uuid,
  p_purchase_document_id uuid
)
returns table (
  out_line_key uuid,
  out_fingerprint text,
  out_actor_app_user_id uuid,
  out_acknowledged_at timestamptz,
  out_note text
)
language sql
stable
security definer
set search_path = ''
as $$
  select line_key, fingerprint, actor_app_user_id, updated_at, note
  from public.price_change_acknowledgments
  where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id;
$$;

revoke all on function public.list_price_change_acknowledgments(uuid, uuid) from public;
grant execute on function public.list_price_change_acknowledgments(uuid, uuid) to service_role;
