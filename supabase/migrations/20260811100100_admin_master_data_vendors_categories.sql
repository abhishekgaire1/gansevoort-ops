-- Admin Master Data milestone: Vendors, Inventory Categories, Spend
-- Categories.
--
-- ============================================================
-- WHAT ALREADY EXISTED (verified by direct inspection before writing this
-- migration):
-- ============================================================
-- vendors (20260811100023): id/organization_id/name/normalized_name/
-- is_active, with an exact-normalized-duplicate unique index already
-- enforced at the DB level. inventory_categories (20260811100004) and
-- spend_categories (20260811100035) already exist with their own
-- case-insensitive duplicate protection and (for spend_categories) cycle
-- prevention. create_inventory_category/create_spend_category
-- (20260811100046) and rename_*/set_*_active (20260811100048) already
-- exist -- this migration does not recreate any of that, it only adds
-- what's genuinely missing:
--   1. Vendor detail fields (legal name, account number, contact, email,
--      phone, notes) -- none of these columns exist yet.
--   2. vendor_aliases -- no alias concept exists anywhere in the schema.
--      vendor_item_mappings.normalized_description is a DIFFERENT concept
--      (item/description-level matching on an invoice LINE), not a
--      vendor-name-header alias.
--   3. Admin-only vendor create/update/activate RPCs, mirroring the exact
--      pattern already established for the Item Master
--      (20260811100098): audited, org-scoped, exact-duplicate BLOCKED at
--      the RPC layer with a clean typed error, fuzzy "possible duplicate"
--      WARN via the same pg_trgm extension already enabled.
--   4. A narrowly-scoped Manager-capable create_vendor_from_receiving --
--      today createVendor (app/actions/vendors.ts) is a plain table
--      INSERT reachable by ANY manager with no admin/manager split at
--      all; this migration's RPC is the new, minimal, audited exception
--      path, while the TypeScript layer (separate change, not part of
--      this migration) locks the general vendor mutation actions to
--      Admin-only.
--   5. Dependency-blocking on category deactivation -- set_inventory_
--      category_active/set_spend_category_active currently have NO
--      blocking at all (verified by reading 20260811100048 directly).
--      Deliberately not touching create_inventory_category/create_
--      spend_category's SQL bodies -- Admin-only enforcement for those is
--      a TypeScript authorization change (requireAdmin instead of
--      requireManagerOrAdmin), not a schema change.
-- ============================================================

create extension if not exists pg_trgm with schema extensions;

-- ============================================================
-- 1. Vendor detail fields (Part 5-6). All optional except name (already
--    NOT NULL). Deliberately NOT added: bank account/routing/ACH, tax id,
--    credit terms, payment method/instructions, W-9 storage, AP balance --
--    all explicitly out of scope for this milestone (Part 5/38/62).
-- ============================================================
alter table public.vendors
  add column legal_name text,
  add column account_number text,
  add column contact_name text,
  add column email text,
  add column phone text,
  add column notes text;

-- ============================================================
-- 2. Vendor aliases (Part 7-8). Durable, org-scoped, normalized the same
--    way as vendors.normalized_name (reuses the existing
--    app/lib/vendors/normalizeVendorName.ts convention: trim + collapse
--    whitespace + uppercase -- "safely handles case/whitespace/simple
--    punctuation without over-normalizing meaningful business names").
--    The unique index is the actual enforcement point for "the exact same
--    normalized alias must not point to two active Vendors in the same
--    org" -- it's global per org across ALL vendors' aliases, not scoped
--    per-vendor, which is exactly what prevents that collision. Plain
--    delete (not deactivate/supersede) -- an alias is a lookup device,
--    not business history; removing a wrong one destroys nothing that
--    Receiving/purchase-document data depends on.
-- ============================================================
create table public.vendor_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  vendor_id uuid not null,
  alias text not null,
  normalized_alias text not null,
  created_by_app_user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint vendor_aliases_alias_check check (char_length(btrim(alias)) > 0),
  constraint vendor_aliases_vendor_org_fk foreign key (vendor_id, organization_id)
    references public.vendors (id, organization_id),
  constraint vendor_aliases_created_by_org_fk foreign key (created_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create unique index vendor_aliases_org_normalized_key
  on public.vendor_aliases (organization_id, normalized_alias);

create index vendor_aliases_org_vendor_idx
  on public.vendor_aliases (organization_id, vendor_id);

alter table public.vendor_aliases enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 3. App-defined SQLSTATEs, continuing the project-wide GA0xx sequence
--    (highest in use before this migration: GA051).
-- ============================================================
-- GA052 DUPLICATE_VENDOR_NAME, GA053 DUPLICATE_VENDOR_ALIAS,
-- GA054 VENDOR_NOT_FOUND, GA055 INVENTORY_CATEGORY_HAS_ACTIVE_ITEMS,
-- GA056 SPEND_CATEGORY_HAS_ACTIVE_CHILDREN, GA057 CATEGORY_NOT_FOUND

-- ============================================================
-- 4. find_similar_active_vendors -- fuzzy "possible duplicate" WARN
--    (Part 14), mirroring find_similar_active_items exactly.
-- ============================================================
create or replace function public.find_similar_active_vendors(
  p_organization_id uuid,
  p_name text,
  p_exclude_vendor_id uuid default null
)
returns table (
  out_vendor_id uuid,
  out_name text,
  out_similarity real,
  out_is_exact boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name,
         extensions.similarity(v.normalized_name, upper(btrim(regexp_replace(p_name, '\s+', ' ', 'g')))),
         v.normalized_name = upper(btrim(regexp_replace(p_name, '\s+', ' ', 'g')))
    from public.vendors v
   where v.organization_id = p_organization_id
     and v.is_active
     and v.id is distinct from p_exclude_vendor_id
     and (
       v.normalized_name = upper(btrim(regexp_replace(p_name, '\s+', ' ', 'g')))
       or extensions.similarity(v.normalized_name, upper(btrim(regexp_replace(p_name, '\s+', ' ', 'g')))) > 0.35
     )
   order by (v.normalized_name = upper(btrim(regexp_replace(p_name, '\s+', ' ', 'g')))) desc,
            extensions.similarity(v.normalized_name, upper(btrim(regexp_replace(p_name, '\s+', ' ', 'g')))) desc
   limit 10;
$$;

revoke all on function public.find_similar_active_vendors(uuid, text, uuid) from public;
grant execute on function public.find_similar_active_vendors(uuid, text, uuid) to service_role;

-- ============================================================
-- 5. create_vendor_admin -- general Admin-only vendor creation (Part 3-6).
--    Authorization (Admin-only) is enforced at the TypeScript action
--    layer via requireAdmin(), same as create_admin_item -- this RPC only
--    enforces org-scoping and duplicate protection, exactly like every
--    other RPC in this schema.
-- ============================================================
create or replace function public.create_vendor_admin(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_name text,
  p_legal_name text default null,
  p_account_number text default null,
  p_contact_name text default null,
  p_email text default null,
  p_phone text default null,
  p_notes text default null
)
returns table (out_vendor_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_normalized text;
  v_vendor_id uuid;
  v_duplicate record;
begin
  if v_name = '' then
    raise exception 'vendor name is required';
  end if;

  v_normalized := upper(btrim(regexp_replace(v_name, '\s+', ' ', 'g')));

  select id, name into v_duplicate
    from public.vendors
   where organization_id = p_organization_id and normalized_name = v_normalized;

  if found then
    raise exception 'a vendor named "%" already exists' , v_duplicate.name
      using errcode = 'GA052', detail = jsonb_build_object('existingVendorId', v_duplicate.id, 'existingVendorName', v_duplicate.name)::text;
  end if;

  v_vendor_id := gen_random_uuid();

  insert into public.vendors (
    id, organization_id, name, normalized_name, is_active,
    legal_name, account_number, contact_name, email, phone, notes
  ) values (
    v_vendor_id, p_organization_id, v_name, v_normalized, true,
    nullif(btrim(coalesce(p_legal_name, '')), ''),
    nullif(btrim(coalesce(p_account_number, '')), ''),
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), '')
  );

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'VENDOR_CREATED', 'vendor', v_vendor_id, jsonb_build_object('name', v_name));

  return query select v_vendor_id;
end;
$$;

revoke all on function public.create_vendor_admin(uuid, uuid, text, text, text, text, text, text, text) from public;
grant execute on function public.create_vendor_admin(uuid, uuid, text, text, text, text, text, text, text) to service_role;

-- ============================================================
-- 6. update_vendor_details -- rename + every other detail field in one
--    call (Part 10: rename preserves the same Vendor ID, mappings,
--    historical documents -- this is a plain UPDATE, never a new row).
-- ============================================================
create or replace function public.update_vendor_details(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_vendor_id uuid,
  p_name text,
  p_legal_name text default null,
  p_account_number text default null,
  p_contact_name text default null,
  p_email text default null,
  p_phone text default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_normalized text;
  v_current record;
  v_duplicate record;
begin
  if v_name = '' then
    raise exception 'vendor name is required';
  end if;

  v_normalized := upper(btrim(regexp_replace(v_name, '\s+', ' ', 'g')));

  select name into v_current from public.vendors where id = p_vendor_id and organization_id = p_organization_id;
  if not found then
    raise exception 'vendor % not found in organization %', p_vendor_id, p_organization_id using errcode = 'GA054';
  end if;

  select id, name into v_duplicate
    from public.vendors
   where organization_id = p_organization_id and normalized_name = v_normalized and id is distinct from p_vendor_id;

  if found then
    raise exception 'a vendor named "%" already exists', v_duplicate.name
      using errcode = 'GA052', detail = jsonb_build_object('existingVendorId', v_duplicate.id, 'existingVendorName', v_duplicate.name)::text;
  end if;

  update public.vendors set
    name = v_name,
    normalized_name = v_normalized,
    legal_name = nullif(btrim(coalesce(p_legal_name, '')), ''),
    account_number = nullif(btrim(coalesce(p_account_number, '')), ''),
    contact_name = nullif(btrim(coalesce(p_contact_name, '')), ''),
    email = nullif(btrim(coalesce(p_email, '')), ''),
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    notes = nullif(btrim(coalesce(p_notes, '')), '')
  where id = p_vendor_id and organization_id = p_organization_id;

  if v_current.name is distinct from v_name then
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_actor_app_user_id, 'VENDOR_RENAMED', 'vendor', p_vendor_id,
      jsonb_build_object('name', v_current.name), jsonb_build_object('name', v_name));
  else
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (p_organization_id, p_actor_app_user_id, 'VENDOR_UPDATED', 'vendor', p_vendor_id, jsonb_build_object('name', v_name));
  end if;
end;
$$;

revoke all on function public.update_vendor_details(uuid, uuid, uuid, text, text, text, text, text, text, text) from public;
grant execute on function public.update_vendor_details(uuid, uuid, uuid, text, text, text, text, text, text, text) to service_role;

-- ============================================================
-- 7. set_vendor_active -- deactivate/reactivate (Part 11-13). No hard
--    delete anywhere. Deliberately NOT blocked by historical or
--    in-progress document references (Part 12: "do NOT block merely
--    because historical documents exist") -- a document's vendor_id FK
--    already fixes the reference permanently at upload time, and every
--    read path that resolves an already-referenced vendor (receivingQueue,
--    document detail) does so unconditionally, never filtered to
--    is_active -- so deactivating a vendor cannot break an in-progress or
--    historical document. It only removes the vendor from the ACTIVE
--    selection list for brand-new uploads/classification going forward.
-- ============================================================
create or replace function public.set_vendor_active(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_vendor_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_active boolean;
begin
  select is_active into v_current_active from public.vendors where id = p_vendor_id and organization_id = p_organization_id;
  if not found then
    raise exception 'vendor % not found in organization %', p_vendor_id, p_organization_id using errcode = 'GA054';
  end if;

  if v_current_active = p_is_active then
    return; -- no-op
  end if;

  update public.vendors set is_active = p_is_active where id = p_vendor_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_actor_app_user_id,
    case when p_is_active then 'VENDOR_REACTIVATED' else 'VENDOR_DEACTIVATED' end,
    'vendor', p_vendor_id, jsonb_build_object('isActive', v_current_active), jsonb_build_object('isActive', p_is_active)
  );
end;
$$;

revoke all on function public.set_vendor_active(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_vendor_active(uuid, uuid, uuid, boolean) to service_role;

-- ============================================================
-- 8. add_vendor_alias / remove_vendor_alias (Part 7-8).
-- ============================================================
create or replace function public.add_vendor_alias(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_vendor_id uuid,
  p_alias text
)
returns table (out_alias_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alias text := btrim(p_alias);
  v_normalized text;
  v_alias_id uuid;
  v_duplicate record;
begin
  if v_alias = '' then
    raise exception 'alias text is required';
  end if;

  if not exists (select 1 from public.vendors where id = p_vendor_id and organization_id = p_organization_id) then
    raise exception 'vendor % not found in organization %', p_vendor_id, p_organization_id using errcode = 'GA054';
  end if;

  v_normalized := upper(btrim(regexp_replace(v_alias, '\s+', ' ', 'g')));

  select va.id, va.alias into v_duplicate
    from public.vendor_aliases va
   where va.organization_id = p_organization_id and va.normalized_alias = v_normalized;

  if found then
    raise exception 'the alias "%" already exists', v_duplicate.alias using errcode = 'GA053';
  end if;

  v_alias_id := gen_random_uuid();

  insert into public.vendor_aliases (id, organization_id, vendor_id, alias, normalized_alias, created_by_app_user_id)
  values (v_alias_id, p_organization_id, p_vendor_id, v_alias, v_normalized, p_actor_app_user_id);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'VENDOR_ALIAS_ADDED', 'vendor', p_vendor_id, jsonb_build_object('alias', v_alias));

  return query select v_alias_id;
end;
$$;

revoke all on function public.add_vendor_alias(uuid, uuid, uuid, text) from public;
grant execute on function public.add_vendor_alias(uuid, uuid, uuid, text) to service_role;

create or replace function public.remove_vendor_alias(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_alias_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendor_id uuid;
  v_alias text;
begin
  select vendor_id, alias into v_vendor_id, v_alias
    from public.vendor_aliases
   where id = p_alias_id and organization_id = p_organization_id;

  if not found then
    raise exception 'vendor alias % not found in organization %', p_alias_id, p_organization_id;
  end if;

  delete from public.vendor_aliases where id = p_alias_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'VENDOR_ALIAS_REMOVED', 'vendor', v_vendor_id, jsonb_build_object('alias', v_alias));
end;
$$;

revoke all on function public.remove_vendor_alias(uuid, uuid, uuid) from public;
grant execute on function public.remove_vendor_alias(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 9. create_vendor_from_receiving -- the controlled Manager exception
--    (Part 15-17/42). Deliberately minimal: name only, no legal name/
--    contact/account number/notes/aliases -- Admin enriches later. The
--    spec's conceptual signature is create_vendor_from_receiving
--    (purchase_document_id, vendor_name); this schema's actual upload
--    flow (verified in Phase A) selects a vendor manually BEFORE a
--    document/purchase_document exists (UploadDocumentForm), so
--    p_purchase_document_id is optional here and, when supplied (the
--    Step1ReviewInvoice vendor-correction context, where a
--    purchase_document genuinely already exists), is validated to belong
--    to the same org purely for audit trail purposes -- the caller
--    attaches the returned vendor id to the document through the exact
--    same mechanism it already uses to set/correct vendor_id (never a
--    second, parallel attachment path). Only an exact-duplicate check
--    (no fuzzy warn) -- this is the fast, minimal unblock path, not the
--    deliberate Admin creation flow, which still gets the full fuzzy
--    check via find_similar_active_vendors on the Admin side.
-- ============================================================
create or replace function public.create_vendor_from_receiving(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_vendor_name text,
  p_purchase_document_id uuid default null
)
returns table (out_vendor_id uuid, out_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_vendor_name);
  v_normalized text;
  v_vendor_id uuid;
  v_duplicate record;
begin
  if v_name = '' then
    raise exception 'vendor name is required';
  end if;

  if p_purchase_document_id is not null and not exists (
    select 1 from public.purchase_documents where id = p_purchase_document_id and organization_id = p_organization_id
  ) then
    raise exception 'purchase_document % not found in organization %', p_purchase_document_id, p_organization_id;
  end if;

  v_normalized := upper(btrim(regexp_replace(v_name, '\s+', ' ', 'g')));

  select id, name into v_duplicate
    from public.vendors
   where organization_id = p_organization_id and normalized_name = v_normalized;

  if found then
    raise exception 'a vendor named "%" already exists -- use it instead of creating a duplicate', v_duplicate.name
      using errcode = 'GA052', detail = jsonb_build_object('existingVendorId', v_duplicate.id, 'existingVendorName', v_duplicate.name)::text;
  end if;

  v_vendor_id := gen_random_uuid();

  insert into public.vendors (id, organization_id, name, normalized_name, is_active)
  values (v_vendor_id, p_organization_id, v_name, v_normalized, true);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'VENDOR_CREATED', 'vendor', v_vendor_id,
    jsonb_build_object('name', v_name, 'source', 'RECEIVING_QUICK_CREATE', 'purchaseDocumentId', p_purchase_document_id));

  return query select v_vendor_id, v_name;
end;
$$;

revoke all on function public.create_vendor_from_receiving(uuid, uuid, text, uuid) from public;
grant execute on function public.create_vendor_from_receiving(uuid, uuid, text, uuid) to service_role;

-- ============================================================
-- 10. Category deactivation dependency-blocking (Part 29). CREATE OR
--     REPLACE of the existing 20260811100048 functions -- same signature,
--     same audit behavior, adding only the blocking check before the
--     UPDATE. Inventory: blocked while ANY active, CONFIRMED, INVENTORY-
--     disposition item still references the category. Spend: blocked
--     while ANY active child category still references it as parent --
--     historical usage alone (classified expense lines) does NOT block,
--     per spec, since those are immutable historical facts, not live
--     configuration.
-- ============================================================
create or replace function public.set_inventory_category_active(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_category_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_item_count integer;
begin
  if not exists (select 1 from public.inventory_categories where id = p_category_id and organization_id = p_organization_id) then
    raise exception 'inventory_category % not found', p_category_id;
  end if;

  if not p_is_active then
    select count(*) into v_active_item_count
      from public.inventory_items
     where category_id = p_category_id
       and organization_id = p_organization_id
       and status = 'active'
       and approval_status = 'CONFIRMED'
       and disposition = 'INVENTORY';

    if v_active_item_count > 0 then
      raise exception 'this category cannot be deactivated because % active inventory item% use% it -- reassign those items first',
        v_active_item_count, (case when v_active_item_count = 1 then '' else 's' end), (case when v_active_item_count = 1 then 's' else '' end)
        using errcode = 'GA055', detail = jsonb_build_object('activeItemCount', v_active_item_count)::text;
    end if;
  end if;

  update public.inventory_categories set is_active = p_is_active where id = p_category_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, case when p_is_active then 'INVENTORY_CATEGORY_ACTIVATED' else 'INVENTORY_CATEGORY_DEACTIVATED' end, 'inventory_category', p_category_id, jsonb_build_object('isActive', p_is_active));
end;
$$;

create or replace function public.set_spend_category_active(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_category_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_child_count integer;
begin
  if not exists (select 1 from public.spend_categories where id = p_category_id and organization_id = p_organization_id) then
    raise exception 'spend_category % not found', p_category_id;
  end if;

  if not p_is_active then
    select count(*) into v_active_child_count
      from public.spend_categories
     where parent_id = p_category_id and organization_id = p_organization_id and is_active;

    if v_active_child_count > 0 then
      raise exception 'this category cannot be deactivated because % active subcategor% depend% on it -- reassign or deactivate those first',
        v_active_child_count, (case when v_active_child_count = 1 then 'y' else 'ies' end), (case when v_active_child_count = 1 then 's' else '' end)
        using errcode = 'GA056', detail = jsonb_build_object('activeChildCount', v_active_child_count)::text;
    end if;
  end if;

  update public.spend_categories set is_active = p_is_active where id = p_category_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, case when p_is_active then 'SPEND_CATEGORY_ACTIVATED' else 'SPEND_CATEGORY_DEACTIVATED' end, 'spend_category', p_category_id, jsonb_build_object('isActive', p_is_active));
end;
$$;

-- Grants already applied by 20260811100048 for both functions above --
-- CREATE OR REPLACE preserves them, but re-stating is harmless and keeps
-- this migration self-contained if read in isolation.
revoke all on function public.set_inventory_category_active(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_inventory_category_active(uuid, uuid, uuid, boolean) to service_role;
revoke all on function public.set_spend_category_active(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_spend_category_active(uuid, uuid, uuid, boolean) to service_role;
