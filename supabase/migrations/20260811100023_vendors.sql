-- Milestone 2A.2: vendors
--
-- Minimal vendor master data. Vendor selection now happens BEFORE document
-- upload (see 20260811100024_documents_vendor_and_type.sql) rather than
-- during later review, so this table has to exist first. normalized_name
-- is a simple deterministic normalization (trim/uppercase/collapse
-- whitespace, computed by application code) used to enforce that two
-- exact-normalized-duplicate vendor names cannot coexist in the same
-- organization -- not a fuzzy-match/merge tool, just prevents "Baldor
-- Foods" and "BALDOR   FOODS" both existing as distinct rows. No address/
-- phone/vendor-items/pack-versions yet -- deferred, not structurally
-- required for manager verification.

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null,
  normalized_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint vendors_name_check check (char_length(btrim(name)) > 0),
  -- composite-FK target for documents/purchase_documents below
  constraint vendors_id_org_key unique (id, organization_id)
);

-- Exact-normalized-duplicate prevention within an organization -- not a
-- fuzzy dedupe; "Baldor" and "Baldor Specialty Foods" remain distinct.
create unique index vendors_org_normalized_name_key
  on public.vendors (organization_id, normalized_name);

create index vendors_org_active_idx
  on public.vendors (organization_id, is_active);

alter table public.vendors enable row level security;
-- Deny-by-default: no policies for anon/authenticated.
