-- Safe editing of confirmed items with inventory-impact protection (Part 2).
--
-- inventory_corrections is the single record type for BOTH new
-- inventory-affecting actions this feature adds: the generic "Adjust
-- Inventory" action (record_inventory_correction, 20260811100141) and the
-- vendor-package "correct inventory from previous receipts" workflow
-- (correct_receipt_package_factor, 20260811100142). It is deliberately a
-- thin, append-only companion to inventory_movements/inventory_movement_
-- lines -- never itself the source of truth for a balance (that remains
-- 100% derived from the movement ledger, per docs/DATABASE.md's "avoid
-- duplicating calculated truths" rule) -- it exists only so the Item
-- History section can render "what correction happened, why, and by whom"
-- without reverse-engineering that from a bare movement row, and so a
-- receipt-package-factor correction can be traced back to the exact
-- posting line and package-version change that caused it.
--
-- Same append-only guarantee as inventory_movements/inventory_movement_
-- lines: forbid_update_delete() (defined in 20260811100005) fires for
-- every role including service_role.

create table public.inventory_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  correction_type text not null check (correction_type in ('MANUAL_ADJUSTMENT', 'RECEIPT_PACKAGE_FACTOR')),
  inventory_item_id uuid not null,
  location_id uuid not null,
  -- Null exactly when quantity_delta = 0 -- a zero-variance manual
  -- adjustment (the manager confirmed the counted quantity already
  -- matched, or a delta of 0 was entered) still gets a row here for the
  -- audit trail, but mirrors cycle-count's own "zero variance -> no
  -- movement" rule: no inventory_movements row is ever created for a
  -- quantity that didn't actually change, since
  -- inventory_movement_lines_entered_quantity_check (20260811100005)
  -- requires entered_quantity > 0 in the first place.
  movement_id uuid,
  movement_line_id uuid references public.inventory_movement_lines (id),
  -- Only set for correction_type = 'RECEIPT_PACKAGE_FACTOR' -- the
  -- specific posting line and package-version change this correction
  -- traces back to. Null for a MANUAL_ADJUSTMENT (no receipt involved).
  source_posting_line_id uuid references public.purchase_document_inventory_posting_lines (id),
  previous_vendor_item_purchase_unit_id uuid references public.vendor_item_purchase_units (id),
  new_vendor_item_purchase_unit_id uuid references public.vendor_item_purchase_units (id),
  previous_quantity numeric not null,
  new_quantity numeric not null,
  quantity_delta numeric not null,
  reason text not null,
  performed_by_app_user_id uuid not null,
  client_request_id text not null,
  created_at timestamptz not null default now(),
  constraint inventory_corrections_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint inventory_corrections_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  constraint inventory_corrections_movement_org_fk foreign key (movement_id, organization_id)
    references public.inventory_movements (id, organization_id),
  constraint inventory_corrections_performed_by_org_fk foreign key (performed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  -- A receipt-package-factor correction must carry both package-version
  -- references and its source posting line; a manual adjustment must
  -- carry none of them -- never a partially-filled ambiguous row.
  constraint inventory_corrections_receipt_fields_check check (
    (correction_type = 'RECEIPT_PACKAGE_FACTOR'
      and source_posting_line_id is not null
      and new_vendor_item_purchase_unit_id is not null)
    or (correction_type = 'MANUAL_ADJUSTMENT'
      and source_posting_line_id is null
      and previous_vendor_item_purchase_unit_id is null
      and new_vendor_item_purchase_unit_id is null)
  ),
  constraint inventory_corrections_quantity_delta_check check (quantity_delta = new_quantity - previous_quantity),
  constraint inventory_corrections_movement_presence_check check (
    (quantity_delta = 0 and movement_id is null and movement_line_id is null)
    or (quantity_delta <> 0 and movement_id is not null and movement_line_id is not null)
  ),
  constraint inventory_corrections_org_client_request_key unique (organization_id, client_request_id)
);

create index inventory_corrections_item_idx
  on public.inventory_corrections (organization_id, inventory_item_id, created_at desc);

create trigger inventory_corrections_forbid_update
  before update on public.inventory_corrections
  for each row execute function public.forbid_update_delete();

create trigger inventory_corrections_forbid_delete
  before delete on public.inventory_corrections
  for each row execute function public.forbid_update_delete();

alter table public.inventory_corrections enable row level security;
-- Deny-by-default: no policies for anon/authenticated -- every read/write
-- flows through the service-role RPCs below, matching every other
-- authoritative table in this schema.
