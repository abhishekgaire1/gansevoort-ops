-- "Where does this inventory item normally go when received?" -- a
-- lightweight, org-scoped memory on the canonical Item Master row itself,
-- distinct from item<->station configuration (which does not exist in this
-- milestone and is not being added here). Nullable: an item with no
-- remembered default simply falls back to whatever the receiving UI's own
-- delivery-level default/blank-selection behavior already does.
alter table public.inventory_items
  add column default_receiving_location_id uuid;

comment on column public.inventory_items.default_receiving_location_id is
  'The location this item was most recently confirmed received into -- a manager-editable convenience prefill for future receiving, never authoritative on its own. Updated only when a manager successfully confirms a receipt with a location for this item (see set_inventory_item_default_receiving_location); never by merely opening or editing a draft form. Historical receipt_lines.location_id rows are never rewritten when this changes.';

alter table public.inventory_items
  add constraint inventory_items_default_receiving_location_org_fk foreign key (default_receiving_location_id, organization_id)
    references public.locations (id, organization_id);

-- Learns (or updates) an item's default receiving location -- called once
-- per line, server-side, only after record_receipt has already succeeded
-- for that line's receipt (see app/actions/receiving.ts). A quiet no-op
-- (no write, no audit event) when the location isn't actually changing, so
-- confirming the same location on a routine delivery doesn't generate
-- audit noise. When it IS changing (including the first time it's ever
-- set), the change is audited -- this is a real, if low-stakes, change to
-- Item Master configuration, not a receiving fact.
create or replace function public.set_inventory_item_default_receiving_location(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_location_id uuid;
begin
  select default_receiving_location_id into v_old_location_id
    from public.inventory_items
   where id = p_inventory_item_id and organization_id = p_organization_id;

  if not found then
    raise exception 'inventory_item % not found', p_inventory_item_id;
  end if;

  if v_old_location_id is not distinct from p_location_id then
    return;
  end if;

  if not exists (select 1 from public.locations where id = p_location_id and organization_id = p_organization_id) then
    raise exception 'location % not found', p_location_id;
  end if;

  update public.inventory_items
     set default_receiving_location_id = p_location_id
   where id = p_inventory_item_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_app_user_id, 'INVENTORY_ITEM_DEFAULT_RECEIVING_LOCATION_CHANGED', 'inventory_item', p_inventory_item_id,
    jsonb_build_object('locationId', v_old_location_id), jsonb_build_object('locationId', p_location_id)
  );
end;
$$;

revoke all on function public.set_inventory_item_default_receiving_location(uuid, uuid, uuid, uuid) from public;
grant execute on function public.set_inventory_item_default_receiving_location(uuid, uuid, uuid, uuid) to service_role;
