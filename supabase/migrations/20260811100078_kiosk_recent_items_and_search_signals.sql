-- Milestone 2A.5 -- kiosk Recent Items + smart search, read model only.
--
-- Recent Items: inventory_movements is written exclusively by
-- record_inventory_withdrawal (20260811100010 onward) inside a single
-- transaction that either fully commits or fully rolls back -- there is
-- no partial-write/abandoned-attempt state to filter out. Every row here
-- already represents a genuinely successful, committed ISSUE_TO_STATION
-- withdrawal, so "last N distinct items an employee successfully
-- withdrew" is a direct read of this table by performed_by_app_user_id,
-- with no separate "attempts" concept to reconcile against. Currently-
-- withdrawable filtering (the §12 Recent Stock Rule) is deliberately NOT
-- done here -- the caller intersects these ids against the exact same
-- list_kiosk_available_inventory-backed item list the browsing grid
-- already uses (app/lib/kiosk/inventoryItems.ts), so Recent can never
-- disagree with the grid about what counts as "currently withdrawable."
--
-- Search: vendor_item_mappings (20260811100036) is already the
-- organization's sole CONFIRMED, active vendor-SKU/description-to-item
-- mapping table -- there is no separate "trusted aliases" table in this
-- schema (docs/DATABASE.md's vendor_item_aliases concept was
-- consolidated into vendor_item_mappings during 2A.3), so it is reused
-- directly rather than inventing a duplicate business concept. Only
-- is_active rows are ever returned -- a superseded or never-confirmed
-- (pending AI suggestion) mapping is never a valid search signal.

create index inventory_movements_org_actor_type_idx
  on public.inventory_movements (organization_id, performed_by_app_user_id, movement_type);

create function public.list_employee_recent_withdrawn_item_ids(
  p_organization_id uuid, p_app_user_id uuid, p_limit integer default 6
)
returns table (
  out_inventory_item_id uuid,
  out_last_withdrawn_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.inventory_item_id, max(m.occurred_at) as last_withdrawn_at
    from public.inventory_movements m
    join public.inventory_movement_lines l on l.movement_id = m.id
   where m.organization_id = p_organization_id
     and m.performed_by_app_user_id = p_app_user_id
     and m.movement_type = 'ISSUE_TO_STATION'
   group by l.inventory_item_id
   order by last_withdrawn_at desc
   limit p_limit;
$$;

revoke all on function public.list_employee_recent_withdrawn_item_ids(uuid, uuid, integer) from public;
grant execute on function public.list_employee_recent_withdrawn_item_ids(uuid, uuid, integer) to service_role;

-- One flat, small result (only active mappings for the org -- never the
-- full vendor-history dataset, never pricing/invoice data): the caller
-- builds a per-item searchable-text index from this once per kiosk
-- session and ranks/matches entirely client-side against the already-
-- small, already-fetched available-item list. No per-keystroke round
-- trip, no N+1.
create function public.list_inventory_item_search_signals(p_organization_id uuid)
returns table (
  out_inventory_item_id uuid,
  out_vendor_sku text,
  out_normalized_description text
)
language sql
stable
security definer
set search_path = ''
as $$
  select inventory_item_id, vendor_sku, normalized_description
    from public.vendor_item_mappings
   where organization_id = p_organization_id
     and is_active;
$$;

revoke all on function public.list_inventory_item_search_signals(uuid) from public;
grant execute on function public.list_inventory_item_search_signals(uuid) to service_role;
