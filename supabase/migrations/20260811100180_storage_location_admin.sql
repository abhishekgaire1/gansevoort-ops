-- Admin storage-location management.
--
-- Adds the first-ever admin surface for public.locations. Storage locations
-- are the SAME location dimension used by stations.location_id,
-- inventory_movements.location_id and receipts.default_location_id -- not a
-- new concept. A location is a valid inventory source/destination only when
-- is_active AND is_storage_eligible (see 20260811100073).
--
-- This migration:
--   1. Adds locations.is_default -- the ONE org-default storage location
--      receiving falls back to. Enforced at most one default per org by a
--      partial unique index, and (by the RPCs below) always active +
--      storage-eligible, so an org always has >= 1 active storage-eligible
--      default once one is set.
--   2. Backfills one default per org (oldest active storage-eligible location).
--   3. Adds guarded admin RPCs mirroring the station admin conventions
--      (SECURITY DEFINER, set search_path = '', fully schema-qualified,
--      p_actor_app_user_id for audit only -- role checks live in the
--      server-action layer via requireAdmin() -- GA0xx error codes,
--      audit_events on every change, revoke/grant to service_role).
--
-- Invariants enforced server-side (never hard-delete; only deactivate):
--   * a location that still holds stock cannot be deactivated or made
--     non-storage-eligible (GA083) -- transfer/zero it first;
--   * the org default cannot be deactivated or made non-eligible (GA084) --
--     set another default first;
--   * a location can be made the default only if it is active + storage
--     eligible (GA085).

alter table public.locations add column is_default boolean not null default false;

create unique index locations_one_default_per_org
  on public.locations (organization_id)
  where is_default;

-- Backfill: one default per org among active storage-eligible locations
-- (oldest first). Generic + data-driven; never a name match.
update public.locations l
   set is_default = true
 where l.id in (
   select distinct on (organization_id) id
     from public.locations
    where is_active and is_storage_eligible
    order by organization_id, created_at asc
 );

-- Helper: does a location currently hold stock in ANY item? Per-item net
-- balance grouped by item (never summed across different base units), using
-- the same movement-type signs as inventory_location_item_balance.
create or replace function public.location_has_stock(
  p_organization_id uuid,
  p_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from (
        select ml.inventory_item_id,
               sum(
                 case
                   when m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN')
                     then ml.normalized_base_quantity
                   when m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT')
                        and m.location_attribution = 'EXACT'
                     then -ml.normalized_base_quantity
                   else 0
                 end
               ) as net
          from public.inventory_movement_lines ml
          join public.inventory_movements m on m.id = ml.movement_id
         where m.organization_id = p_organization_id
           and m.location_id = p_location_id
         group by ml.inventory_item_id
      ) b
     where b.net > 0
  );
$$;

revoke all on function public.location_has_stock(uuid, uuid) from public;
grant execute on function public.location_has_stock(uuid, uuid) to service_role;

-- 1. Create a storage location.
create or replace function public.create_location(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_name text,
  p_is_storage_eligible boolean default true
)
returns table (out_location_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_timezone text;
  v_location_id uuid;
begin
  if v_name = '' then
    raise exception 'location name is required' using errcode = 'GA082';
  end if;

  if exists (
    select 1 from public.locations
     where organization_id = p_organization_id and lower(name) = lower(v_name)
  ) then
    raise exception 'a location named "%" already exists', v_name using errcode = 'GA082';
  end if;

  -- Inherit the org timezone from an existing location; fall back sensibly.
  select timezone into v_timezone
    from public.locations
   where organization_id = p_organization_id
   order by created_at asc
   limit 1;
  v_timezone := coalesce(v_timezone, 'America/New_York');

  insert into public.locations (organization_id, name, timezone, is_active, is_storage_eligible)
  values (p_organization_id, v_name, v_timezone, true, coalesce(p_is_storage_eligible, true))
  returning id into v_location_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'LOCATION_CREATED', 'location', v_location_id,
          jsonb_build_object('name', v_name, 'isStorageEligible', coalesce(p_is_storage_eligible, true)));

  return query select v_location_id;
end;
$$;

revoke all on function public.create_location(uuid, uuid, text, boolean) from public;
grant execute on function public.create_location(uuid, uuid, text, boolean) to service_role;

-- 2. Rename a location.
create or replace function public.update_location_name(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_location_id uuid,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not exists (select 1 from public.locations where id = p_location_id and organization_id = p_organization_id) then
    raise exception 'location % not found in organization %', p_location_id, p_organization_id using errcode = 'GA034';
  end if;
  if v_name = '' then
    raise exception 'location name is required' using errcode = 'GA082';
  end if;
  if exists (
    select 1 from public.locations
     where organization_id = p_organization_id and lower(name) = lower(v_name) and id <> p_location_id
  ) then
    raise exception 'a location named "%" already exists', v_name using errcode = 'GA082';
  end if;

  update public.locations set name = v_name where id = p_location_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'LOCATION_RENAMED', 'location', p_location_id,
          jsonb_build_object('name', v_name));
end;
$$;

revoke all on function public.update_location_name(uuid, uuid, uuid, text) from public;
grant execute on function public.update_location_name(uuid, uuid, uuid, text) to service_role;

-- 3. Set storage eligibility.
create or replace function public.set_location_storage_eligible(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_location_id uuid,
  p_is_storage_eligible boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_default boolean;
begin
  select is_default into v_is_default
    from public.locations where id = p_location_id and organization_id = p_organization_id;
  if v_is_default is null then
    raise exception 'location % not found in organization %', p_location_id, p_organization_id using errcode = 'GA034';
  end if;

  if not p_is_storage_eligible then
    if v_is_default then
      raise exception 'the default storage location must stay storage-eligible; set another default first'
        using errcode = 'GA084';
    end if;
    if public.location_has_stock(p_organization_id, p_location_id) then
      raise exception 'this location still holds stock; transfer or zero it before removing storage eligibility'
        using errcode = 'GA083';
    end if;
  end if;

  update public.locations set is_storage_eligible = p_is_storage_eligible
   where id = p_location_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'LOCATION_STORAGE_ELIGIBILITY_CHANGED', 'location', p_location_id,
          jsonb_build_object('isStorageEligible', p_is_storage_eligible));
end;
$$;

revoke all on function public.set_location_storage_eligible(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_location_storage_eligible(uuid, uuid, uuid, boolean) to service_role;

-- 4. Activate / deactivate.
create or replace function public.set_location_status(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_location_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_default boolean;
begin
  select is_default into v_is_default
    from public.locations where id = p_location_id and organization_id = p_organization_id;
  if v_is_default is null then
    raise exception 'location % not found in organization %', p_location_id, p_organization_id using errcode = 'GA034';
  end if;

  if not p_is_active then
    if v_is_default then
      raise exception 'the default storage location cannot be deactivated; set another default first'
        using errcode = 'GA084';
    end if;
    if public.location_has_stock(p_organization_id, p_location_id) then
      raise exception 'this location still holds stock; transfer or zero it before deactivating'
        using errcode = 'GA083';
    end if;
  end if;

  update public.locations set is_active = p_is_active where id = p_location_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'LOCATION_STATUS_CHANGED', 'location', p_location_id,
          jsonb_build_object('isActive', p_is_active));
end;
$$;

revoke all on function public.set_location_status(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_location_status(uuid, uuid, uuid, boolean) to service_role;

-- 5. Set the org default storage location.
create or replace function public.set_default_location(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_location_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean;
  v_eligible boolean;
begin
  select is_active, is_storage_eligible into v_active, v_eligible
    from public.locations where id = p_location_id and organization_id = p_organization_id;
  if v_active is null then
    raise exception 'location % not found in organization %', p_location_id, p_organization_id using errcode = 'GA034';
  end if;
  if not (v_active and v_eligible) then
    raise exception 'only an active, storage-eligible location can be the default' using errcode = 'GA085';
  end if;

  -- Unset the current default first (partial unique index allows only one).
  update public.locations set is_default = false
   where organization_id = p_organization_id and is_default and id <> p_location_id;
  update public.locations set is_default = true
   where id = p_location_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'LOCATION_SET_DEFAULT', 'location', p_location_id,
          jsonb_build_object('isDefault', true));
end;
$$;

revoke all on function public.set_default_location(uuid, uuid, uuid) from public;
grant execute on function public.set_default_location(uuid, uuid, uuid) to service_role;

-- 6. Admin overview: every location with the dependency signals an admin
--    needs before deactivating one.
create or replace function public.list_admin_locations(
  p_organization_id uuid
)
returns table (
  out_id uuid,
  out_name text,
  out_is_active boolean,
  out_is_storage_eligible boolean,
  out_is_default boolean,
  out_has_stock boolean,
  out_movement_count bigint,
  out_station_count bigint,
  out_receipt_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    l.id,
    l.name,
    l.is_active,
    l.is_storage_eligible,
    l.is_default,
    public.location_has_stock(p_organization_id, l.id),
    (select count(*) from public.inventory_movements m where m.organization_id = p_organization_id and m.location_id = l.id),
    (select count(*) from public.stations s where s.organization_id = p_organization_id and s.location_id = l.id),
    (select count(*) from public.receipts r where r.organization_id = p_organization_id and r.default_location_id = l.id)
  from public.locations l
  where l.organization_id = p_organization_id
  order by l.is_active desc, l.name asc;
$$;

revoke all on function public.list_admin_locations(uuid) from public;
grant execute on function public.list_admin_locations(uuid) to service_role;
