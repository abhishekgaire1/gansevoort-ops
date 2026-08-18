-- 2A.3 closeout: the minimal /manager/settings/categories admin surface --
-- rename and activate/deactivate for both inventory and spend categories,
-- audited the same way create_inventory_category/create_spend_category
-- already are (20260811100046). No destructive deletion, no schema
-- change -- these are pure functions over the existing tables/columns.
create or replace function public.rename_inventory_category(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_category_id uuid,
  p_new_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_new_name);
  v_old_name text;
begin
  if v_name = '' then
    raise exception 'category name is required';
  end if;

  select name into v_old_name
    from public.inventory_categories
   where id = p_category_id and organization_id = p_organization_id;

  if not found then
    raise exception 'inventory_category % not found', p_category_id;
  end if;

  if exists (
    select 1 from public.inventory_categories
     where organization_id = p_organization_id
       and lower(name) = lower(v_name)
       and id <> p_category_id
  ) then
    raise exception 'an inventory category named "%" already exists', v_name
      using errcode = 'GA014';
  end if;

  update public.inventory_categories set name = v_name where id = p_category_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_app_user_id, 'INVENTORY_CATEGORY_RENAMED', 'inventory_category', p_category_id, jsonb_build_object('name', v_old_name), jsonb_build_object('name', v_name));
end;
$$;

revoke all on function public.rename_inventory_category(uuid, uuid, uuid, text) from public;
grant execute on function public.rename_inventory_category(uuid, uuid, uuid, text) to service_role;

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
begin
  if not exists (select 1 from public.inventory_categories where id = p_category_id and organization_id = p_organization_id) then
    raise exception 'inventory_category % not found', p_category_id;
  end if;

  update public.inventory_categories set is_active = p_is_active where id = p_category_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, case when p_is_active then 'INVENTORY_CATEGORY_ACTIVATED' else 'INVENTORY_CATEGORY_DEACTIVATED' end, 'inventory_category', p_category_id, jsonb_build_object('isActive', p_is_active));
end;
$$;

revoke all on function public.set_inventory_category_active(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_inventory_category_active(uuid, uuid, uuid, boolean) to service_role;

create or replace function public.rename_spend_category(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_category_id uuid,
  p_new_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_new_name);
  v_old_name text;
  v_parent_id uuid;
begin
  if v_name = '' then
    raise exception 'category name is required';
  end if;

  select name, parent_id into v_old_name, v_parent_id
    from public.spend_categories
   where id = p_category_id and organization_id = p_organization_id;

  if not found then
    raise exception 'spend_category % not found', p_category_id;
  end if;

  if (
    v_parent_id is null and exists (
      select 1 from public.spend_categories
       where organization_id = p_organization_id and parent_id is null and lower(name) = lower(v_name) and id <> p_category_id
    )
  ) or (
    v_parent_id is not null and exists (
      select 1 from public.spend_categories
       where organization_id = p_organization_id and parent_id = v_parent_id and lower(name) = lower(v_name) and id <> p_category_id
    )
  ) then
    raise exception 'a spend category named "%" already exists at that level', v_name
      using errcode = 'GA014';
  end if;

  update public.spend_categories set name = v_name where id = p_category_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_app_user_id, 'SPEND_CATEGORY_RENAMED', 'spend_category', p_category_id, jsonb_build_object('name', v_old_name), jsonb_build_object('name', v_name));
end;
$$;

revoke all on function public.rename_spend_category(uuid, uuid, uuid, text) from public;
grant execute on function public.rename_spend_category(uuid, uuid, uuid, text) to service_role;

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
begin
  if not exists (select 1 from public.spend_categories where id = p_category_id and organization_id = p_organization_id) then
    raise exception 'spend_category % not found', p_category_id;
  end if;

  update public.spend_categories set is_active = p_is_active where id = p_category_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, case when p_is_active then 'SPEND_CATEGORY_ACTIVATED' else 'SPEND_CATEGORY_DEACTIVATED' end, 'spend_category', p_category_id, jsonb_build_object('isActive', p_is_active));
end;
$$;

revoke all on function public.set_spend_category_active(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_spend_category_active(uuid, uuid, uuid, boolean) to service_role;
