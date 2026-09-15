-- Vendor classification -- INVENTORY vs NON_INVENTORY vendors, per
-- explicit operator direction ("classify vendors as inventory and non
-- inventory so it's clearer"). This is an identity LABEL plus a
-- classification DEFAULT, never a restriction: an INVENTORY vendor may
-- still supply non-inventory (expense) lines, and a NON_INVENTORY
-- vendor may occasionally supply an inventory item -- the manager's
-- per-line disposition choice always wins. Only the DEFAULT the
-- new-item classification form starts from is vendor-aware (TS layer;
-- see app/lib/itemMaster/defaultDispositionForVendor).
--
-- Named "classification" deliberately, NOT "disposition" -- disposition
-- is the ITEM-level concept (inventory_items.disposition) and reusing
-- the word for a different entity's soft label would conflate two
-- distinct business concepts.
--
-- Backfill (operator decision): every existing vendor starts as
-- INVENTORY -- the column default does the backfill; admins reclassify
-- the non-inventory vendors (office supplies, cleaning, services) by
-- hand in Vendor admin.
alter table public.vendors
  add column classification text not null default 'INVENTORY'
  check (classification in ('INVENTORY', 'NON_INVENTORY'));

-- ============================================================
-- create_vendor_admin -- adds p_classification (defaulted, so existing
-- named-args callers keep working). Signature change => DROP + CREATE
-- with re-issued per-signature grants; the old arg-type list is
-- dropped explicitly so no second overload can ever linger (the
-- increment_pin_rate_limit ambiguity lesson, 20260811100148).
-- ============================================================
drop function if exists public.create_vendor_admin(uuid, uuid, text, text, text, text, text, text, text);

create function public.create_vendor_admin(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_name text,
  p_legal_name text default null,
  p_account_number text default null,
  p_contact_name text default null,
  p_email text default null,
  p_phone text default null,
  p_notes text default null,
  p_classification text default 'INVENTORY'
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

  if p_classification not in ('INVENTORY', 'NON_INVENTORY') then
    raise exception 'invalid vendor classification %', p_classification
      using errcode = 'GA033';
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
    legal_name, account_number, contact_name, email, phone, notes,
    classification
  ) values (
    v_vendor_id, p_organization_id, v_name, v_normalized, true,
    nullif(btrim(coalesce(p_legal_name, '')), ''),
    nullif(btrim(coalesce(p_account_number, '')), ''),
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    p_classification
  );

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'VENDOR_CREATED', 'vendor', v_vendor_id,
    jsonb_build_object('name', v_name, 'classification', p_classification));

  return query select v_vendor_id;
end;
$$;

revoke all on function public.create_vendor_admin(uuid, uuid, text, text, text, text, text, text, text, text) from public;
grant execute on function public.create_vendor_admin(uuid, uuid, text, text, text, text, text, text, text, text) to service_role;

-- ============================================================
-- update_vendor_details -- adds p_classification, written like every
-- other detail field (same-id in-place UPDATE, never a new row). The
-- audit keeps the existing VENDOR_RENAMED/VENDOR_UPDATED split and now
-- carries classification in after_state (and before_state when it
-- actually changed) so a reclassification is visible in history.
-- ============================================================
drop function if exists public.update_vendor_details(uuid, uuid, uuid, text, text, text, text, text, text, text);

create function public.update_vendor_details(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_vendor_id uuid,
  p_name text,
  p_legal_name text default null,
  p_account_number text default null,
  p_contact_name text default null,
  p_email text default null,
  p_phone text default null,
  p_notes text default null,
  p_classification text default 'INVENTORY'
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

  if p_classification not in ('INVENTORY', 'NON_INVENTORY') then
    raise exception 'invalid vendor classification %', p_classification
      using errcode = 'GA033';
  end if;

  v_normalized := upper(btrim(regexp_replace(v_name, '\s+', ' ', 'g')));

  select name, classification into v_current from public.vendors where id = p_vendor_id and organization_id = p_organization_id;
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
    notes = nullif(btrim(coalesce(p_notes, '')), ''),
    classification = p_classification
  where id = p_vendor_id and organization_id = p_organization_id;

  if v_current.name is distinct from v_name then
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_actor_app_user_id, 'VENDOR_RENAMED', 'vendor', p_vendor_id,
      jsonb_build_object('name', v_current.name, 'classification', v_current.classification),
      jsonb_build_object('name', v_name, 'classification', p_classification));
  else
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_actor_app_user_id, 'VENDOR_UPDATED', 'vendor', p_vendor_id,
      jsonb_build_object('name', v_current.name, 'classification', v_current.classification),
      jsonb_build_object('name', v_name, 'classification', p_classification));
  end if;
end;
$$;

revoke all on function public.update_vendor_details(uuid, uuid, uuid, text, text, text, text, text, text, text, text) from public;
grant execute on function public.update_vendor_details(uuid, uuid, uuid, text, text, text, text, text, text, text, text) to service_role;

-- create_vendor_from_receiving deliberately UNCHANGED: the Manager
-- quick-create is minimal by design and lands on the column default
-- (INVENTORY); an admin reclassifies afterwards if needed.
