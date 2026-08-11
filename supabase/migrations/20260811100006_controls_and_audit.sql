-- Database foundation: controls and audit
--
-- control_rules is item-scoped and optionally station-scoped only -- no
-- category-wide or organization-wide rules, because a single
-- threshold_quantity cannot meaningfully compare across items with
-- different (and possibly incompatible) base units. A withdrawal is
-- evaluated against a single station-specific rule if one exists, else the
-- item's all-station default rule; there is no cumulative/time-windowed
-- aggregation in V1 (a rule evaluates a single withdrawal only).
--
-- exceptions stores typed historical snapshot columns (observed_quantity,
-- threshold_quantity_at_detection, base_unit_id) rather than depending on
-- the current value of control_rules, so a later edit to a rule's threshold
-- cannot retroactively change what an old exception meant.
--
-- audit_events is append-only, reusing the same guard trigger created for
-- inventory_movements/inventory_movement_lines in the previous migration.

create table public.control_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  rule_type text not null,
  inventory_item_id uuid not null,
  station_id uuid,
  threshold_quantity numeric not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_app_user_id uuid,
  constraint control_rules_rule_type_check check (rule_type in ('HIGH_WITHDRAWAL')),
  constraint control_rules_threshold_check check (threshold_quantity > 0),
  -- the rule's item and station (when present) must belong to the same organization
  constraint control_rules_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint control_rules_station_org_fk foreign key (station_id, organization_id)
    references public.stations (id, organization_id),
  -- the creating app user (when present) must belong to the same organization
  constraint control_rules_created_by_org_fk foreign key (created_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  -- composite-FK target for exceptions.control_rule_id below
  constraint control_rules_id_org_key unique (id, organization_id)
);

-- at most one active all-station default rule per item
create unique index control_rules_one_default_per_item
  on public.control_rules (inventory_item_id)
  where station_id is null and is_active;

-- at most one active station-specific rule per item+station
create unique index control_rules_one_per_item_station
  on public.control_rules (inventory_item_id, station_id)
  where station_id is not null and is_active;

-- reuses the shared updated_at guard defined in the identity_and_access migration
create trigger control_rules_set_updated_at
  before update on public.control_rules
  for each row execute function public.set_updated_at();

create table public.exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  exception_type text not null,
  severity text not null default 'normal',
  status text not null default 'open',
  control_rule_id uuid,
  source_movement_id uuid,
  source_movement_line_id uuid,
  inventory_item_id uuid,
  station_id uuid,
  observed_quantity numeric,
  threshold_quantity_at_detection numeric,
  base_unit_id uuid references public.units (id),
  details jsonb,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_app_user_id uuid,
  resolution_notes text,
  constraint exceptions_exception_type_check check (exception_type in ('HIGH_WITHDRAWAL')),
  constraint exceptions_severity_check check (severity in ('low', 'normal', 'high')),
  constraint exceptions_status_check check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  constraint exceptions_observed_qty_check check (observed_quantity is null or observed_quantity > 0),
  constraint exceptions_threshold_at_detection_check
    check (threshold_quantity_at_detection is null or threshold_quantity_at_detection > 0),
  -- HIGH_WITHDRAWAL is the only V1 exception type and must carry a full
  -- snapshot of the withdrawal it was raised from; left nullable at the
  -- column level only because future exception types won't all have this
  -- shape
  constraint exceptions_high_withdrawal_snapshot_check check (
    exception_type <> 'HIGH_WITHDRAWAL'
    or (
      source_movement_id is not null
      and source_movement_line_id is not null
      and inventory_item_id is not null
      and station_id is not null
      and observed_quantity is not null
      and threshold_quantity_at_detection is not null
      and base_unit_id is not null
    )
  ),
  -- every reference below (when present) must belong to the same
  -- organization as the exception itself
  constraint exceptions_control_rule_org_fk foreign key (control_rule_id, organization_id)
    references public.control_rules (id, organization_id),
  constraint exceptions_source_movement_org_fk foreign key (source_movement_id, organization_id)
    references public.inventory_movements (id, organization_id),
  constraint exceptions_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint exceptions_station_org_fk foreign key (station_id, organization_id)
    references public.stations (id, organization_id),
  constraint exceptions_resolved_by_org_fk foreign key (resolved_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  -- guarantees source_movement_line_id actually belongs to source_movement_id
  -- (its organization then follows transitively, since
  -- inventory_movement_lines.organization_id is already forced to match its
  -- parent movement's organization)
  constraint exceptions_source_movement_line_fk foreign key (source_movement_line_id, source_movement_id)
    references public.inventory_movement_lines (id, movement_id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  actor_app_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  before_state jsonb,
  after_state jsonb,
  occurred_at timestamptz not null default now(),
  -- the acting app user (when present) must belong to the same organization
  -- as the audit event
  constraint audit_events_actor_org_fk foreign key (actor_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create trigger audit_events_forbid_update
  before update on public.audit_events
  for each row execute function public.forbid_update_delete();

create trigger audit_events_forbid_delete
  before delete on public.audit_events
  for each row execute function public.forbid_update_delete();

alter table public.control_rules enable row level security;
alter table public.exceptions enable row level security;
alter table public.audit_events enable row level security;
-- Deny-by-default: no policies for anon/authenticated.
