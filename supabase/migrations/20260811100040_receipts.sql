-- Milestone 2A.3 (part 6 of 8): receipts + receipt_lines.
--
-- receipts.purchase_document_id points at a SPECIFIC, PERMANENT revision
-- row -- never source_document_id, never revision_group_id directly.
-- purchase_documents rows are permanent once written and frozen from
-- further UPDATE once VERIFIED/DISCARDED, making a specific revision's id
-- the safest anchor anywhere in this schema for something that must
-- survive a later amendment without duplication or orphaning. "All
-- receiving activity for this business document across every amendment"
-- is a plain join through purchase_documents.revision_group_id -- neither
-- revision_group_id nor source_document_id need their own column here.
--
-- Corrections to an already-recorded receipt are explicit, linked
-- supersession -- never "insert a new row and assume the newest wins." A
-- CORRECTION-kind receipt is a full restatement of everything it
-- corrects, not a line-by-line patch. Every genuinely new, unrelated
-- delivery is always receipt_kind='DELIVERY', never a correction.
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  receipt_kind text not null,
  corrects_receipt_id uuid,
  default_location_id uuid,
  delivery_verified_by_employee_id_snapshot uuid,
  recorded_by_app_user_id uuid not null,
  occurred_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  constraint receipts_receipt_kind_check check (receipt_kind in ('DELIVERY', 'CORRECTION')),
  constraint receipts_correction_requires_target_check
    check ((receipt_kind = 'CORRECTION') = (corrects_receipt_id is not null)),
  constraint receipts_not_self_correction check (corrects_receipt_id is distinct from id),
  constraint receipts_pd_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id),
  constraint receipts_default_location_org_fk foreign key (default_location_id, organization_id)
    references public.locations (id, organization_id),
  constraint receipts_verifier_snapshot_org_fk foreign key (delivery_verified_by_employee_id_snapshot, organization_id)
    references public.employees (id, organization_id),
  constraint receipts_recorded_by_org_fk foreign key (recorded_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  -- Composite-FK target for the structural correction-integrity guarantee
  -- below.
  constraint receipts_id_org_pd_key unique (id, organization_id, purchase_document_id),
  -- Composite-FK target for receipt_lines.receipt_id below (org-safe
  -- cross-table reference pattern used throughout this schema) -- distinct
  -- from receipts_id_org_pd_key above because receipt_lines has no
  -- purchase_document_id of its own to include in a 3-column match.
  constraint receipts_id_org_key unique (id, organization_id),
  -- STRUCTURALLY IMPOSSIBLE cross-document correction, not merely
  -- unvalidated: this composite FK requires the correcting row's OWN
  -- purchase_document_id to equal the corrected row's purchase_document_id
  -- at the constraint level -- the exact same technique already used in
  -- this codebase for purchase_documents.previous_revision_id (designed
  -- there to make cross-group predecessor links structurally impossible).
  -- A later purchase-document amendment never re-anchors an existing
  -- receipt or its correction chain: receipts is append-only, and a
  -- correction's purchase_document_id is permanently inherited from its
  -- chain's original receipt at creation time -- amendments only ever
  -- create a NEW purchase_documents row, never touch or delete the old
  -- one, so nothing here can retroactively change. Correcting an old
  -- receipt continues its original chain, unconditionally.
  constraint receipts_corrects_receipt_fk foreign key (corrects_receipt_id, organization_id, purchase_document_id)
    references public.receipts (id, organization_id, purchase_document_id)
);

-- At most one correction may directly target a given receipt -- keeps a
-- correction chain a simple linked list (A <- B <- C), never a fork.
create unique index receipts_org_corrects_key
  on public.receipts (organization_id, corrects_receipt_id)
  where corrects_receipt_id is not null;

create index receipts_pd_idx
  on public.receipts (purchase_document_id, occurred_at desc);

create trigger receipts_forbid_update
  before update on public.receipts
  for each row execute function public.forbid_update_delete();

create trigger receipts_forbid_delete
  before delete on public.receipts
  for each row execute function public.forbid_update_delete();

alter table public.receipts enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

create table public.receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null,
  organization_id uuid not null references public.organizations (id),
  line_number_snapshot integer,
  matched_line_key uuid,
  vendor_sku_snapshot text,
  description_snapshot text,
  invoice_package_quantity numeric,
  invoice_package_unit text,
  invoice_measured_quantity numeric,
  invoice_measured_unit text,
  actual_received_package_quantity numeric,
  actual_received_package_unit text,
  actual_verified_base_quantity numeric,
  actual_verified_base_unit_id uuid references public.units (id),
  -- Authoritative, LINE-level posting destination -- a single vendor
  -- delivery can legitimately contain items going to several different
  -- locations (Central Walk-In, Central Freezer, Dry Storage) at once;
  -- forcing one location per receipt would be actively wrong. Nullable at
  -- receiving time -- nothing about location resolution blocks recording
  -- a receipt, only later blocks 2A.4 from posting that specific line.
  location_id uuid,
  condition_status text not null default 'RECEIVED_AS_INVOICED',
  notes text,
  created_at timestamptz not null default now(),
  constraint receipt_lines_receipt_org_fk foreign key (receipt_id, organization_id)
    references public.receipts (id, organization_id),
  constraint receipt_lines_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  constraint receipt_lines_condition_status_check check (condition_status in (
    'RECEIVED_AS_INVOICED', 'SHORT', 'DAMAGED', 'WRONG_ITEM', 'NOT_RECEIVED', 'EXCESS', 'OTHER'
  )),
  constraint receipt_lines_invoice_package_quantity_check check (invoice_package_quantity is null or invoice_package_quantity >= 0),
  constraint receipt_lines_invoice_measured_quantity_check check (invoice_measured_quantity is null or invoice_measured_quantity >= 0),
  constraint receipt_lines_actual_received_package_quantity_check check (actual_received_package_quantity is null or actual_received_package_quantity >= 0),
  constraint receipt_lines_actual_verified_base_quantity_check check (actual_verified_base_quantity is null or actual_verified_base_quantity >= 0)
);

create index receipt_lines_receipt_idx
  on public.receipt_lines (receipt_id);

create trigger receipt_lines_forbid_update
  before update on public.receipt_lines
  for each row execute function public.forbid_update_delete();

create trigger receipt_lines_forbid_delete
  before delete on public.receipt_lines
  for each row execute function public.forbid_update_delete();

alter table public.receipt_lines enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- The only set 2A.4 (or any UI wanting "what do we currently believe was
-- received") is ever allowed to read: every receipt for this purchase
-- document that is NOT the target of any other receipt's
-- corrects_receipt_id (i.e. not yet superseded). Derived fresh on every
-- read, never a stored "is_current" flag to keep in sync.
create or replace function public.effective_receipts_for_purchase_document(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns setof public.receipts
language sql
stable
security definer
set search_path = ''
as $$
  select r.*
    from public.receipts r
   where r.purchase_document_id = p_purchase_document_id
     and r.organization_id = p_organization_id
     and not exists (
       select 1 from public.receipts newer
        where newer.corrects_receipt_id = r.id
     );
$$;

revoke all on function public.effective_receipts_for_purchase_document(uuid, uuid) from public;
grant execute on function public.effective_receipts_for_purchase_document(uuid, uuid) to service_role;
