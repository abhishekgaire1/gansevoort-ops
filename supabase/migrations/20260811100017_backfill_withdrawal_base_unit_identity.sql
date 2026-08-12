-- Backfill canonical base-unit identity mappings for existing items
--
-- Root cause: the withdrawal-unit simplification (see
-- 20260811100016_enforce_withdrawal_base_unit.sql and
-- app/lib/kiosk/withdrawalUnit.ts) requires every withdrawable item to have
-- an ACTIVE, self-referencing inventory_item_units row for its own
-- base_unit_id (conversion_factor 1, requires_actual_measurement false) --
-- neither the schema nor record_inventory_withdrawal's trigger were changed
-- to special-case "the base unit is always trivially valid for itself," so
-- master data must supply that row explicitly. Items seeded before this
-- convention existed (e.g. an item originally configured with only a BOX
-- entry unit for weight/measurement) never received it, which is why the
-- kiosk reports "This item isn't set up for withdrawal yet."
--
-- scripts/dev-seed.ts already creates this row for every item it seeds,
-- but that only takes effect the next time it's explicitly run -- it does
-- not retroactively fix items seeded by an earlier version of that script,
-- and dev-seed.ts is dev-only anyway (never runs against staging/prod).
-- This migration is the actual fix: a one-time, idempotent, environment-
-- agnostic backfill that inserts the missing self-referencing row for
-- every existing item that lacks one, in every organization -- not just
-- Gansevoort's dev data. Safe to run more than once (the WHERE NOT EXISTS
-- guard skips any item that already has the row, from dev-seed.ts or
-- otherwise).
--
-- is_default_entry_unit is deliberately left false: an item may already
-- have a different unit marked default (e.g. BOX), and
-- inventory_item_units_one_default_per_item allows only one default row
-- per item -- the kiosk never reads is_default_entry_unit at all, so this
-- has no behavioral effect either way.
--
-- Existing package-unit rows (BOX/CASE/...) are never touched, only new
-- rows are ever inserted -- this is purely additive.

insert into public.inventory_item_units (
  inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
)
select i.id, i.base_unit_id, 1, false, false, true
from public.inventory_items i
where not exists (
  select 1
    from public.inventory_item_units iu
   where iu.inventory_item_id = i.id
     and iu.unit_id = i.base_unit_id
);
