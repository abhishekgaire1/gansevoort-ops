-- Milestone 2A.3 (part 2 of 8): vendor_item_mappings.
--
-- Confirmed, organization-scoped memory of "this vendor's SKU/description
-- means this internal item" -- every row here is, by construction, already
-- confirmed. There is deliberately no PENDING_REVIEW state on this table:
-- an unconfirmed AI suggestion lives only as a transient row on
-- purchase_document_line_classifications (added later in this sequence)
-- until a manager confirms it, at which point a row here is written.
--
-- Remapping never rewrites history: deactivate the old row
-- (is_active=false, superseded_by_mapping_id set) and insert a new one,
-- never an in-place UPDATE of inventory_item_id. The partial-unique-on-
-- is_active indexes let the old (inactive) and new (active) rows coexist.

create table public.vendor_item_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  vendor_id uuid not null,
  match_basis text not null,
  vendor_sku text,
  normalized_description text,
  inventory_item_id uuid not null,
  is_active boolean not null default true,
  confirmed_by_app_user_id uuid not null,
  confirmed_at timestamptz not null default now(),
  superseded_by_mapping_id uuid,
  created_at timestamptz not null default now(),
  constraint vendor_item_mappings_id_org_key unique (id, organization_id),
  constraint vendor_item_mappings_match_basis_check check (match_basis in ('VENDOR_SKU', 'NORMALIZED_DESCRIPTION')),
  constraint vendor_item_mappings_basis_value_check check (
    (match_basis = 'VENDOR_SKU' and vendor_sku is not null)
    or (match_basis = 'NORMALIZED_DESCRIPTION' and normalized_description is not null)
  ),
  constraint vendor_item_mappings_vendor_org_fk foreign key (vendor_id, organization_id)
    references public.vendors (id, organization_id),
  -- The mapped item must be a real, manager-confirmed Item Master entry --
  -- a PENDING_REVIEW proposal is never an acceptable mapping target. RPC-
  -- level validation (§ the confirm RPCs) is the actual enforcement point
  -- since approval_status is mutable state, not something a static FK can
  -- constrain -- this composite FK only guarantees org-scoping.
  constraint vendor_item_mappings_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint vendor_item_mappings_confirmed_by_org_fk foreign key (confirmed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint vendor_item_mappings_superseded_by_org_fk foreign key (superseded_by_mapping_id, organization_id)
    references public.vendor_item_mappings (id, organization_id),
  constraint vendor_item_mappings_not_self_superseded check (superseded_by_mapping_id is distinct from id)
);

create unique index vendor_item_mappings_org_vendor_sku_key
  on public.vendor_item_mappings (organization_id, vendor_id, vendor_sku)
  where is_active and match_basis = 'VENDOR_SKU';

create unique index vendor_item_mappings_org_vendor_description_key
  on public.vendor_item_mappings (organization_id, vendor_id, normalized_description)
  where is_active and match_basis = 'NORMALIZED_DESCRIPTION';

create index vendor_item_mappings_org_item_idx
  on public.vendor_item_mappings (organization_id, inventory_item_id);

alter table public.vendor_item_mappings enable row level security;
-- Deny-by-default: no policies for anon/authenticated.
