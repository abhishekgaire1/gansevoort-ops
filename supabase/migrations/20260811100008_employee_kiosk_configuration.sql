-- Employee kiosk station configuration
--
-- Per-employee kiosk station behavior, added directly to employees rather
-- than a separate employee_station assignment/scheduling table (explicitly
-- out of scope -- this is a kiosk UX setting, not a labor-allocation
-- system; docs/ROADMAP.md defers "Detailed labor allocation by station").
--
-- auto_resolve_station=true is meaningless without a default_station_id to
-- resolve to, hence the check constraint. default_station_id must belong to
-- the employee's own organization -- enforced with the same composite-FK
-- pattern used throughout this schema (targets stations_id_org_key, already
-- created in the organizations_locations_stations migration).
--
-- record_inventory_withdrawal (a later migration in this slice) is the
-- actual enforcement point for these columns; this migration only stores
-- the configuration.

alter table public.employees
  add column default_station_id uuid,
  add column auto_resolve_station boolean not null default false,
  add column can_change_station boolean not null default false;

alter table public.employees
  add constraint employees_default_station_org_fk
    foreign key (default_station_id, organization_id)
    references public.stations (id, organization_id);

alter table public.employees
  add constraint employees_auto_resolve_requires_default_check
    check (not auto_resolve_station or default_station_id is not null);
