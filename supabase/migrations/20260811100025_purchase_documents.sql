-- Milestone 2A.2: purchase_documents + purchase_document_lines
--
-- The durable, correctable-until-verified business record for a purchasing
-- document (invoice, receipt, or credit memo) -- generalized rather than
-- invoice-only, since a receipt is not an invoice and must not be modeled
-- as one. Manager corrections are stored here, separately from both the
-- immutable original document and the immutable AI extraction attempt it
-- was initialized from -- three structurally separate layers, none of
-- which mutate each other.
--
-- Lifecycle: DRAFT -> READY_FOR_VERIFICATION -> VERIFIED, plus the single
-- reject transition READY_FOR_VERIFICATION -> DRAFT. Fully mutable while
-- DRAFT (by the preparer only -- see the RPCs in later migrations); locked
-- from ALL editing while READY_FOR_VERIFICATION at the DATABASE level, not
-- just by RPC WHERE-clause gating -- the freeze triggers below reject any
-- raw UPDATE/DELETE against a READY_FOR_VERIFICATION row or its lines
-- except the two sanctioned transitions (-> VERIFIED, -> DRAFT); frozen
-- entirely (blocked UPDATE and DELETE, no per-column exception) once
-- VERIFIED. A future milestone can design a real correction/reversal
-- workflow once real usage shows what shape it needs; this migration
-- doesn't half-build one.
--
-- Header columns are generic (document_number/document_date), not
-- invoice-only (invoice_number/invoice_date) -- their meaning is
-- type-dependent ("Invoice #" / "Receipt #" / "Credit Memo #"), which is
-- also what makes type-aware duplicate detection and archive filenames
-- fall out of the same columns instead of needing per-type branches
-- everywhere. po_number/delivery_date are INVOICE-relevant only and are
-- always legitimately null for RECEIPT/CREDIT_MEMO.
--
-- No non-negativity CHECK constraints on money/quantity columns:
-- document_type = 'CREDIT_MEMO' is a first-class supported type and credit
-- memos can legitimately carry negative amounts -- a blanket constraint
-- would be actively wrong for that case. Deterministic ReviewFlag-style
-- validation (app/lib/purchaseDocuments/validatePurchaseDocumentDraft.ts)
-- stays purely advisory, exactly as it already is for document_extractions.

-- Two separate composite FK targets on document_extractions, both needed:
-- (id, organization_id) is the target for purchase_documents_source_
-- extraction_org_fk below (org-safety, matching the same pattern used by
-- every other composite FK in this schema); (id, document_id) is the
-- target for purchase_documents_source_extraction_document_fk (guarantees
-- the referenced extraction attempt actually belongs to the referenced
-- document, not merely the same organization -- independently, the org-safe
-- FK alone can't express that). Both trivially satisfiable against any
-- existing data (id is already the primary key, so a UNIQUE constraint on
-- id plus any second column can never find a duplicate) -- adds two FK
-- targets without touching any existing data or 2A.1 behavior.
alter table public.document_extractions
  add constraint document_extractions_id_org_key unique (id, organization_id);

alter table public.document_extractions
  add constraint document_extractions_id_document_key unique (id, document_id);

create table public.purchase_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  source_document_id uuid not null,
  source_extraction_id uuid not null,
  vendor_id uuid,
  document_type text,
  document_number text,
  document_date date,
  po_number text,
  delivery_date date,
  subtotal numeric,
  tax numeric,
  fees numeric,
  total numeric,
  currency text,
  status text not null default 'DRAFT',
  created_by_app_user_id uuid not null,
  verified_by_app_user_id uuid,
  verified_at timestamptz,
  last_returned_by_app_user_id uuid,
  last_returned_reason text,
  last_returned_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_documents_status_check check (status in ('DRAFT', 'READY_FOR_VERIFICATION', 'VERIFIED')),
  constraint purchase_documents_document_type_check
    check (document_type is null or document_type in ('INVOICE', 'RECEIPT', 'CREDIT_MEMO')),
  -- composite-FK target for purchase_document_lines below
  constraint purchase_documents_id_org_key unique (id, organization_id),
  -- at most one purchase document per source document
  constraint purchase_documents_org_source_document_key unique (organization_id, source_document_id),
  constraint purchase_documents_source_document_org_fk foreign key (source_document_id, organization_id)
    references public.documents (id, organization_id),
  constraint purchase_documents_source_extraction_org_fk foreign key (source_extraction_id, organization_id)
    references public.document_extractions (id, organization_id),
  -- guarantees the referenced extraction attempt actually belongs to the
  -- referenced document, not merely the same organization
  constraint purchase_documents_source_extraction_document_fk foreign key (source_extraction_id, source_document_id)
    references public.document_extractions (id, document_id),
  constraint purchase_documents_vendor_org_fk foreign key (vendor_id, organization_id)
    references public.vendors (id, organization_id),
  constraint purchase_documents_created_by_org_fk foreign key (created_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint purchase_documents_verified_by_org_fk foreign key (verified_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint purchase_documents_returned_by_org_fk foreign key (last_returned_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create index purchase_documents_org_vendor_idx on public.purchase_documents (organization_id, vendor_id);
create index purchase_documents_org_status_idx on public.purchase_documents (organization_id, status);
create index purchase_documents_org_number_idx
  on public.purchase_documents (organization_id, vendor_id, document_type, document_number);

create trigger purchase_documents_set_updated_at
  before update on public.purchase_documents
  for each row execute function public.set_updated_at();

-- Once VERIFIED, blocked from ALL further modification -- no per-column
-- exception, no unfreeze path. While READY_FOR_VERIFICATION, blocked from
-- all modification EXCEPT the two sanctioned transitions performed by
-- verify_purchase_document (-> VERIFIED) and return_purchase_document_to_draft
-- (-> DRAFT) -- this is the DB-level backstop for "READY_FOR_VERIFICATION
-- cannot be edited by anyone," previously enforced only by save_purchase_
-- document_draft's own `status = 'DRAFT'` WHERE clause with no independent
-- trigger-level protection. A sanctioned transition is recognized purely by
-- its effect (status flips to VERIFIED or DRAFT, no business field changes)
-- rather than by trusting the caller, so a raw UPDATE that tries to smuggle
-- a business-field change alongside a legitimate-looking status flip is
-- still rejected. Reuses GA003 (the existing "frozen/locked" code) rather
-- than minting a new one -- the semantics are the same: this row is locked
-- from the kind of edit being attempted.
create or replace function public.purchase_documents_forbid_locked_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('VERIFIED', 'READY_FOR_VERIFICATION') then
      raise exception 'purchase_document % is % and cannot be deleted', old.id, old.status
        using errcode = 'GA003';
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE' from here.
  if old.status = 'VERIFIED' then
    raise exception 'purchase_document % is verified and cannot be modified', old.id
      using errcode = 'GA003';
  end if;

  if old.status = 'READY_FOR_VERIFICATION' then
    if new.status not in ('VERIFIED', 'DRAFT') then
      raise exception 'purchase_document % is ready for verification and locked from editing', old.id
        using errcode = 'GA003';
    end if;
    if new.vendor_id is distinct from old.vendor_id
       or new.document_type is distinct from old.document_type
       or new.document_number is distinct from old.document_number
       or new.document_date is distinct from old.document_date
       or new.po_number is distinct from old.po_number
       or new.delivery_date is distinct from old.delivery_date
       or new.subtotal is distinct from old.subtotal
       or new.tax is distinct from old.tax
       or new.fees is distinct from old.fees
       or new.total is distinct from old.total
       or new.currency is distinct from old.currency
       or new.source_document_id is distinct from old.source_document_id
       or new.source_extraction_id is distinct from old.source_extraction_id
       or new.created_by_app_user_id is distinct from old.created_by_app_user_id
    then
      raise exception 'purchase_document % is ready for verification and locked from editing business fields', old.id
        using errcode = 'GA003';
    end if;
  end if;

  return new;
end;
$$;

create trigger purchase_documents_forbid_locked_update
  before update on public.purchase_documents
  for each row execute function public.purchase_documents_forbid_locked_mutation();

create trigger purchase_documents_forbid_locked_delete
  before delete on public.purchase_documents
  for each row execute function public.purchase_documents_forbid_locked_mutation();

alter table public.purchase_documents enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

create table public.purchase_document_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  purchase_document_id uuid not null,
  line_number integer not null,
  vendor_sku text,
  description text,
  package_quantity numeric,
  package_unit text,
  measured_quantity numeric,
  measured_unit text,
  unit_price numeric,
  price_basis_unit text,
  line_total numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_document_lines_line_number_check check (line_number > 0),
  constraint purchase_document_lines_purchase_document_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id)
);

create unique index purchase_document_lines_doc_line_number_key
  on public.purchase_document_lines (purchase_document_id, line_number);

create trigger purchase_document_lines_set_updated_at
  before update on public.purchase_document_lines
  for each row execute function public.set_updated_at();

-- Blocked from INSERT/UPDATE/DELETE once the parent purchase_document is
-- READY_FOR_VERIFICATION or VERIFIED -- mirrors purchase_documents' own
-- lock, applied via the parent's current status rather than a column on
-- this table (no line exists in isolation from its parent's lifecycle).
-- Unlike the header trigger, lines need no "sanctioned transition" carve-out
-- at all: none of the three RPCs that touch READY_FOR_VERIFICATION or
-- VERIFIED (submit/verify/return) ever write to purchase_document_lines --
-- only save_purchase_document_draft does, and it's already gated to
-- status='DRAFT' by its own WHERE clause. Line UUIDs are not stable across
-- a save_purchase_document_draft call (see the RPC migration): every save
-- replaces the whole line set, since nothing in this milestone references
-- purchase_document_lines.id from elsewhere -- a deliberate, accepted
-- tradeoff, not an oversight.
create or replace function public.purchase_document_lines_forbid_when_locked()
returns trigger
language plpgsql
as $$
declare
  v_parent_status text;
begin
  select pd.status into v_parent_status
    from public.purchase_documents pd
   where pd.id = coalesce(new.purchase_document_id, old.purchase_document_id);

  if v_parent_status in ('VERIFIED', 'READY_FOR_VERIFICATION') then
    raise exception 'purchase_document_lines for purchase_document % cannot be modified: the purchase document is % and locked',
      coalesce(new.purchase_document_id, old.purchase_document_id), v_parent_status
      using errcode = 'GA003';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger purchase_document_lines_forbid_when_locked
  before insert or update or delete on public.purchase_document_lines
  for each row execute function public.purchase_document_lines_forbid_when_locked();

alter table public.purchase_document_lines enable row level security;
-- Deny-by-default: no policies for anon/authenticated.
