-- Purchase-versus-usage unit model: existing-item usage-unit management.
--
-- Lets a manager, OUTSIDE the purchase-document approval flow, add a
-- secondary kiosk usage unit to an already-confirmed item, deactivate an
-- existing secondary prospectively, or change which active unit is
-- primary -- without ever touching historical movement/posting records
-- (neither table those reference, inventory_item_units and
-- inventory_movement_lines, is written by any function in this file).
--
-- New app-defined SQLSTATEs: GA067 NO_ACTIVE_PRIMARY_USAGE_UNIT, GA068
-- USAGE_UNIT_NOT_ACTIVE_FOR_ITEM (highest in use before this migration:
-- GA066, allocated in 20260811100115). GA035/GA036 were considered and
-- rejected -- app/lib/admin/errors.ts already claims both.

-- ============================================================
-- 1. Add or reconfigure the secondary usage unit for an existing item
-- ============================================================
create or replace function public.manager_add_secondary_usage_unit(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_secondary_unit_code text,
  p_secondary_conversion_factor numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_result uuid;
begin
  select id, disposition, approval_status into v_item
    from public.inventory_items
   where id = p_inventory_item_id and organization_id = p_organization_id;

  if not found then
    raise exception 'inventory_item % not found in organization %', p_inventory_item_id, p_organization_id
      using errcode = 'GA009';
  end if;

  if v_item.disposition <> 'INVENTORY' or v_item.approval_status <> 'CONFIRMED' then
    raise exception 'inventory_item % is not a confirmed inventory item' , p_inventory_item_id
      using errcode = 'GA009';
  end if;

  if not exists (
    select 1 from public.inventory_item_usage_units
     where organization_id = p_organization_id and inventory_item_id = p_inventory_item_id and usage_slot = 1 and is_active
  ) then
    raise exception 'inventory_item % has no active primary usage unit to add a secondary alongside', p_inventory_item_id
      using errcode = 'GA067';
  end if;

  v_result := public.upsert_secondary_usage_unit(p_organization_id, p_inventory_item_id, p_secondary_unit_code, p_secondary_conversion_factor, p_app_user_id);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_SECONDARY_USAGE_UNIT_CONFIGURED', 'inventory_item', p_inventory_item_id,
    jsonb_build_object('secondaryUnitCode', p_secondary_unit_code, 'secondaryConversionFactor', p_secondary_conversion_factor, 'usageUnitId', v_result));

  return v_result;
end;
$$;

revoke all on function public.manager_add_secondary_usage_unit(uuid, uuid, uuid, text, numeric) from public;
grant execute on function public.manager_add_secondary_usage_unit(uuid, uuid, uuid, text, numeric) to service_role;

-- ============================================================
-- 2. Deactivate the secondary usage unit prospectively
-- ============================================================
-- Never deletes the row -- it stays as inactive history, exactly like
-- every other soft-deactivation pattern in this schema. Existing
-- movement lines already reference inventory_item_units directly (never
-- this table), so deactivating a slot can never reinterpret a historical
-- withdrawal; it only stops NEW withdrawals from using that unit going
-- forward (enforced by 20260811100115's trigger check).
create or replace function public.manager_deactivate_secondary_usage_unit(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot record;
begin
  select id into v_slot
    from public.inventory_item_usage_units
   where organization_id = p_organization_id
     and inventory_item_id = p_inventory_item_id
     and usage_slot = 2
     and is_active;

  if not found then
    -- Already has no active secondary -- idempotent no-op.
    return;
  end if;

  update public.inventory_item_usage_units
     set is_active = false
   where id = v_slot.id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_SECONDARY_USAGE_UNIT_DEACTIVATED', 'inventory_item', p_inventory_item_id,
    jsonb_build_object('deactivatedUsageUnitId', v_slot.id));
end;
$$;

revoke all on function public.manager_deactivate_secondary_usage_unit(uuid, uuid, uuid) from public;
grant execute on function public.manager_deactivate_secondary_usage_unit(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 3. Change which active usage unit is primary
-- ============================================================
-- Swaps slot numbers between the two currently-active rows. Done as a
-- deactivate-then-reactivate dance (never a direct UPDATE ... SET
-- usage_slot swap) so the partial unique index
-- inventory_item_usage_units_active_slot_key never sees two active rows
-- claiming the same slot at once, even momentarily within this same
-- transaction -- PostgreSQL checks a non-deferred unique index after
-- each individual statement, not only at COMMIT.
create or replace function public.manager_set_primary_usage_unit(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_usage_unit_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_other record;
begin
  select id, usage_slot into v_target
    from public.inventory_item_usage_units
   where id = p_usage_unit_id
     and organization_id = p_organization_id
     and inventory_item_id = p_inventory_item_id
     and is_active;

  if not found then
    raise exception 'usage unit % is not an active usage unit for inventory_item %', p_usage_unit_id, p_inventory_item_id
      using errcode = 'GA068';
  end if;

  if v_target.usage_slot = 1 then
    -- Already primary -- idempotent no-op.
    return;
  end if;

  select id, usage_slot into v_other
    from public.inventory_item_usage_units
   where organization_id = p_organization_id
     and inventory_item_id = p_inventory_item_id
     and is_active
     and id <> p_usage_unit_id;

  if not found then
    -- No other active slot -- simply promote the target directly, no
    -- swap needed, no transient collision possible.
    update public.inventory_item_usage_units set usage_slot = 1 where id = v_target.id;
  else
    -- Three-step dance: deactivate the current primary, move the target
    -- into slot 1, then reactivate the former primary into slot 2.
    update public.inventory_item_usage_units set is_active = false where id = v_other.id;
    update public.inventory_item_usage_units set usage_slot = 1 where id = v_target.id;
    update public.inventory_item_usage_units set usage_slot = 2, is_active = true where id = v_other.id;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_PRIMARY_USAGE_UNIT_CHANGED', 'inventory_item', p_inventory_item_id,
    jsonb_build_object('newPrimaryUsageUnitId', p_usage_unit_id));
end;
$$;

revoke all on function public.manager_set_primary_usage_unit(uuid, uuid, uuid, uuid) from public;
grant execute on function public.manager_set_primary_usage_unit(uuid, uuid, uuid, uuid) to service_role;
