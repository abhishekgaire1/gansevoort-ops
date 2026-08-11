-- Drop redundant single-column FKs superseded by organization/hierarchy
-- composite FKs on the same table pair.
--
-- Several tables were built with BOTH a plain single-column FK (from
-- `col uuid references target (id)` at column-definition time) AND a
-- stronger composite FK (col, organization_id) references target (id,
-- organization_id) added later in the same migration for org-integrity.
-- Both FKs express the same logical relationship -- "this row's parent is
-- that row in target" -- and the composite FK's existence check subsumes
-- the plain FK's existence check entirely, since target's composite unique
-- key (id, organization_id) already guarantees a matching (id) is unique.
-- Keeping both creates two distinct pg_constraint FK entries between the
-- same table pair, which PostgREST refuses to disambiguate for embedded
-- resource queries (e.g. `app_users.select("employees(...)")`) without an
-- explicit `!constraint_name` hint -- this is what broke the PIN
-- integration tests ("more than one relationship was found for 'app_users'
-- and 'employees'").
--
-- In each case below, only the plain FK is dropped. The composite FK is
-- kept and is strictly stronger: it enforces both "parent exists" and
-- "parent belongs to the same organization" in one constraint. No ON
-- DELETE behavior changes in practice -- none of the plain FKs being
-- dropped were DEFERRABLE, so their ON DELETE semantics (default NO ACTION,
-- or RESTRICT for inventory_movement_lines.movement_id) are already
-- immediate/non-deferred, identical in effect to the composite FK's default
-- NO ACTION.
--
-- 1. app_users.employee_id -> employees
--    Plain:     app_users_employee_id_fkey (from `employee_id uuid not
--               null unique references public.employees (id)`)
--    Composite: app_users_employee_org_fk (employee_id, organization_id)
--               references employees (id, organization_id)
--    The column's UNIQUE constraint (app_users_employee_id_key) is
--    untouched -- it enforces the 1:1 app_user:employee business rule and
--    is unrelated to which relationship PostgREST embeds through.
alter table public.app_users
  drop constraint app_users_employee_id_fkey;

-- 2. stations.location_id -> locations
--    Plain:     stations_location_id_fkey (from `location_id uuid not
--               null references public.locations (id)`)
--    Composite: stations_location_org_fk (location_id, organization_id)
--               references locations (id, organization_id)
alter table public.stations
  drop constraint stations_location_id_fkey;

-- 3. inventory_movement_lines.movement_id -> inventory_movements
--    Plain:     inventory_movement_lines_movement_id_fkey (from
--               `movement_id uuid not null references
--               public.inventory_movements (id) on delete restrict`)
--    Composite: inventory_movement_lines_movement_org_fk (movement_id,
--               organization_id) references inventory_movements (id,
--               organization_id)
--    inventory_movements additionally has an unconditional BEFORE DELETE
--    trigger (forbid_update_delete) that already blocks every delete
--    regardless of FK action, so ON DELETE RESTRICT on the dropped plain
--    FK was already unreachable in practice.
alter table public.inventory_movement_lines
  drop constraint inventory_movement_lines_movement_id_fkey;

-- Supabase's managed Postgres installs `pgrst_ddl_watch` /
-- `pgrst_drop_watch` event triggers that automatically NOTIFY PostgREST to
-- reload its schema cache after DDL like this runs, so no manual action is
-- normally required. The explicit NOTIFY below is a harmless, idempotent
-- belt-and-suspenders in case that automatic reload is ever delayed or
-- disabled in a given environment -- PostgREST otherwise keeps serving the
-- old (ambiguous) relationship graph from its cached introspection until
-- the next reload.
notify pgrst, 'reload schema';
