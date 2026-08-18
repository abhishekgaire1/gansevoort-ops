-- Confirmed vendor invoice-unit workflow.
--
-- Three separate unit facts must never be conflated:
--   A. INVOICE/BILLING UNIT -- what THIS invoice's bare quantity means
--      (e.g. Bartlett SKU 101102's "48" means 48 PIECE).
--   B. VENDOR PACKAGING -- how the vendor packages/sells the item
--      (e.g. 1 CASE = 12 PIECE), already captured by inventory_item_units.
--   C. BASE INVENTORY UNIT -- how we track inventory internally (PIECE),
--      already captured by inventory_items.base_unit_id.
-- This migration adds the smallest additive storage for fact A, at two
-- distinct scopes:
--   1. vendor_item_mappings.confirmed_invoice_unit_id -- "this vendor's
--      invoice quantity for this SKU is NORMALLY expressed in this unit."
--      Mutable, and deliberately so (a vendor can genuinely change how
--      they bill), which is exactly why it must never be the sole source
--      of historical truth for an already-recorded invoice (see 2 below).
--   2. purchase_document_line_invoice_unit_confirmations -- a permanent,
--      append-only record of what a manager confirmed THIS SPECIFIC
--      invoice line's quantity meant, at confirmation time. Even if the
--      vendor's remembered default later changes, this specific line's
--      historical meaning ("quantity=48, unit=PIECE") never does.
--
-- purchase_document_lines itself cannot carry this fact directly: it is
-- structurally blocked from INSERT/UPDATE/DELETE once its parent
-- purchase_document reaches READY_FOR_VERIFICATION/VERIFIED (see
-- purchase_document_lines_forbid_when_locked, 20260811100025), and
-- receiving only ever happens on a VERIFIED document -- exactly the
-- situation this codebase's established pattern already solves via a
-- companion append-only table (document_delivery_verifier_corrections,
-- 20260811100038) rather than carving an update exception into a locked
-- table. This migration reuses that exact pattern instead of inventing a
-- new one.

-- ============================================================
-- 1. Vendor-level memory (fact A, mutable, per organization+vendor+SKU)
-- ============================================================

alter table public.vendor_item_mappings
  add column confirmed_invoice_unit_id uuid references public.units (id);

comment on column public.vendor_item_mappings.confirmed_invoice_unit_id is
  'This vendor''s invoice/billing quantity for this SKU is normally expressed in this unit -- distinct from the mapped item''s base unit and from vendor packaging/conversion config. Never authoritative for an already-recorded invoice line on its own (see purchase_document_line_invoice_unit_confirmations for the permanent per-line snapshot); only ever set by a manager confirming it during receiving (see confirm_receiving_line_invoice_unit), never inferred from AI suggestion alone.';

-- ============================================================
-- 2. Current-invoice snapshot (fact A, permanent, per specific line)
-- ============================================================

create table public.purchase_document_line_invoice_unit_confirmations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  line_key uuid not null,
  confirmed_invoice_unit_id uuid not null references public.units (id),
  confirmed_by_app_user_id uuid not null,
  confirmed_at timestamptz not null default now(),
  -- Org-safety for purchase_document_id, transitively covering line_key
  -- too (the second FK below only matches a line_key that genuinely
  -- belongs to this exact purchase_document_id).
  constraint pdl_invoice_unit_confirmations_pd_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id),
  constraint pdl_invoice_unit_confirmations_pd_line_fk foreign key (purchase_document_id, line_key)
    references public.purchase_document_lines (purchase_document_id, line_key),
  constraint pdl_invoice_unit_confirmations_actor_org_fk foreign key (confirmed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create index pdl_invoice_unit_confirmations_doc_line_idx
  on public.purchase_document_line_invoice_unit_confirmations (purchase_document_id, line_key, confirmed_at desc);

create trigger pdl_invoice_unit_confirmations_forbid_update
  before update on public.purchase_document_line_invoice_unit_confirmations
  for each row execute function public.forbid_update_delete();

create trigger pdl_invoice_unit_confirmations_forbid_delete
  before delete on public.purchase_document_line_invoice_unit_confirmations
  for each row execute function public.forbid_update_delete();

alter table public.purchase_document_line_invoice_unit_confirmations enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- Current effective confirmed invoice unit for one specific line = the
-- most recent confirmation row, or null if the line has never been
-- confirmed (still genuinely unresolved from the invoice's own history).
create or replace function public.current_purchase_document_line_invoice_unit_id(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.confirmed_invoice_unit_id
    from public.purchase_document_line_invoice_unit_confirmations c
   where c.purchase_document_id = p_purchase_document_id
     and c.line_key = p_line_key
     and c.organization_id = p_organization_id
   order by c.confirmed_at desc
   limit 1;
$$;

revoke all on function public.current_purchase_document_line_invoice_unit_id(uuid, uuid, uuid) from public;
grant execute on function public.current_purchase_document_line_invoice_unit_id(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 3. The confirmation action itself
-- ============================================================

-- Resolves an ambiguous (or explicitly conflicting) invoice unit for one
-- receiving line, inline in Step 3 -- Receive Delivery, per manager
-- confirmation. Two independent, no-op-safe effects:
--   1. Always records the permanent per-line snapshot (unless it already
--      says the same thing) -- this is what preserves "quantity=48,
--      unit=PIECE" for THIS invoice regardless of what the vendor's
--      remembered default does later.
--   2. Only when p_remember_for_vendor -- and only for a VENDOR_SKU-basis
--      mapping (a NORMALIZED_DESCRIPTION-basis mapping has no SKU to key
--      vendor-wide memory off of, so remembering is simply skipped for
--      those lines, never guessed) -- updates the vendor's remembered
--      default too, audited, unless it already says the same thing.
-- AI suggestion is never a caller of this function on its own; only a
-- manager-initiated receiving confirmation is.
create or replace function public.confirm_receiving_line_invoice_unit(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_confirmed_invoice_unit_code text,
  p_remember_for_vendor boolean default true
)
returns table (
  out_line_confirmation_recorded boolean,
  out_vendor_mapping_updated boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmed_invoice_unit_id uuid;
  v_current_line_unit_id uuid;
  v_vendor_id uuid;
  v_vendor_sku text;
  v_mapping_id uuid;
  v_mapping_current_unit_id uuid;
  v_line_recorded boolean := false;
  v_vendor_updated boolean := false;
begin
  select id into v_confirmed_invoice_unit_id from public.units where code = p_confirmed_invoice_unit_code;
  if not found then
    raise exception 'unit % not found', p_confirmed_invoice_unit_code;
  end if;

  if not exists (
    select 1 from public.purchase_document_lines
     where purchase_document_id = p_purchase_document_id
       and line_key = p_line_key
       and organization_id = p_organization_id
  ) then
    raise exception 'purchase_document_line % / % not found', p_purchase_document_id, p_line_key;
  end if;

  v_current_line_unit_id := public.current_purchase_document_line_invoice_unit_id(p_purchase_document_id, p_line_key, p_organization_id);

  if v_current_line_unit_id is distinct from v_confirmed_invoice_unit_id then
    insert into public.purchase_document_line_invoice_unit_confirmations (
      organization_id, purchase_document_id, line_key, confirmed_invoice_unit_id, confirmed_by_app_user_id
    ) values (
      p_organization_id, p_purchase_document_id, p_line_key, v_confirmed_invoice_unit_id, p_app_user_id
    );
    v_line_recorded := true;
  end if;

  if p_remember_for_vendor then
    select vendor_id into v_vendor_id
      from public.purchase_documents
     where id = p_purchase_document_id and organization_id = p_organization_id;

    select vendor_sku into v_vendor_sku
      from public.purchase_document_lines
     where purchase_document_id = p_purchase_document_id
       and line_key = p_line_key
       and organization_id = p_organization_id;

    if v_vendor_sku is not null then
      select id, confirmed_invoice_unit_id into v_mapping_id, v_mapping_current_unit_id
        from public.vendor_item_mappings
       where organization_id = p_organization_id
         and vendor_id = v_vendor_id
         and vendor_sku = v_vendor_sku
         and match_basis = 'VENDOR_SKU'
         and is_active
       limit 1;

      if v_mapping_id is not null and v_mapping_current_unit_id is distinct from v_confirmed_invoice_unit_id then
        update public.vendor_item_mappings
           set confirmed_invoice_unit_id = v_confirmed_invoice_unit_id
         where id = v_mapping_id;

        insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
        values (
          p_organization_id, p_app_user_id, 'VENDOR_ITEM_MAPPING_INVOICE_UNIT_CHANGED', 'vendor_item_mapping', v_mapping_id,
          jsonb_build_object('confirmedInvoiceUnitId', v_mapping_current_unit_id), jsonb_build_object('confirmedInvoiceUnitId', v_confirmed_invoice_unit_id)
        );
        v_vendor_updated := true;
      end if;
    end if;
  end if;

  return query select v_line_recorded, v_vendor_updated;
end;
$$;

revoke all on function public.confirm_receiving_line_invoice_unit(uuid, uuid, uuid, uuid, text, boolean) from public;
grant execute on function public.confirm_receiving_line_invoice_unit(uuid, uuid, uuid, uuid, text, boolean) to service_role;
