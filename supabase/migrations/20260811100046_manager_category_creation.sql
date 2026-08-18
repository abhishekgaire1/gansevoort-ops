-- 2A.3 refinement (part 3): managers may create a missing canonical
-- inventory/spend category on the spot, from inside the new-item review
-- flow -- the initial canonical taxonomy (seeded via
-- scripts/seed-canonical-categories.ts, never a migration) is a starting
-- point, not permanently closed. AI itself may never call these -- only a
-- manager action does, and every creation is audited with the acting
-- manager's identity. Duplicate prevention is the SAME case-insensitive
-- constraints already enforced by 20260811100004/20260811100035 -- this
-- RPC just maps that 23505 into a clean, typed error instead of a raw
-- constraint violation.
create or replace function public.create_inventory_category(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_name text
)
returns table (out_category_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_category_id uuid;
begin
  if v_name = '' then
    raise exception 'category name is required';
  end if;

  select id into v_category_id
    from public.inventory_categories
   where organization_id = p_organization_id
     and lower(name) = lower(v_name);

  if found then
    raise exception 'an inventory category named "%" already exists', v_name
      using errcode = 'GA014';
  end if;

  insert into public.inventory_categories (organization_id, name)
  values (p_organization_id, v_name)
  returning id into v_category_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'INVENTORY_CATEGORY_CREATED', 'inventory_category', v_category_id, jsonb_build_object('name', v_name));

  return query select v_category_id;
end;
$$;

revoke all on function public.create_inventory_category(uuid, uuid, text) from public;
grant execute on function public.create_inventory_category(uuid, uuid, text) to service_role;

create or replace function public.create_spend_category(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_name text,
  p_parent_id uuid default null
)
returns table (out_category_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_category_id uuid;
begin
  if v_name = '' then
    raise exception 'category name is required';
  end if;

  if p_parent_id is not null and not exists (
    select 1 from public.spend_categories where id = p_parent_id and organization_id = p_organization_id
  ) then
    raise exception 'parent spend_category % not found in organization %', p_parent_id, p_organization_id;
  end if;

  if p_parent_id is null then
    select id into v_category_id
      from public.spend_categories
     where organization_id = p_organization_id and parent_id is null and lower(name) = lower(v_name);
  else
    select id into v_category_id
      from public.spend_categories
     where organization_id = p_organization_id and parent_id = p_parent_id and lower(name) = lower(v_name);
  end if;

  if found then
    raise exception 'a spend category named "%" already exists at that level', v_name
      using errcode = 'GA014';
  end if;

  insert into public.spend_categories (organization_id, name, parent_id)
  values (p_organization_id, v_name, p_parent_id)
  returning id into v_category_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'SPEND_CATEGORY_CREATED', 'spend_category', v_category_id, jsonb_build_object('name', v_name, 'parentId', p_parent_id));

  return query select v_category_id;
end;
$$;

revoke all on function public.create_spend_category(uuid, uuid, text, uuid) from public;
grant execute on function public.create_spend_category(uuid, uuid, text, uuid) to service_role;
