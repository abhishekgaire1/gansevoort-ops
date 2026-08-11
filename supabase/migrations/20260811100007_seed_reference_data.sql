-- Database foundation: seed reference data
--
-- Only genuinely universal/documented data is seeded: the unit vocabulary
-- named verbatim in docs/BUSINESS_RULES.md ("Inventory Units"), the three
-- confirmed V1 roles, and the one organization/location named in
-- docs/PRODUCT.md ("Gansevoort Liberty Market -- WTC"). No stations,
-- categories, or items are seeded -- none are named in the docs, and
-- inventing them would violate "do not invent product requirements."

insert into public.units (code, name, unit_type) values
  ('BOX', 'Box', 'COUNT'),
  ('CASE', 'Case', 'COUNT'),
  ('PACK', 'Pack', 'COUNT'),
  ('PIECE', 'Piece', 'COUNT'),
  ('BOTTLE', 'Bottle', 'COUNT'),
  ('LB', 'Pound', 'WEIGHT'),
  ('OZ', 'Ounce', 'WEIGHT'),
  ('GAL', 'Gallon', 'VOLUME'),
  ('L', 'Liter', 'VOLUME');

insert into public.roles (name, description) values
  ('employee', 'Can record inventory withdrawals via PIN.'),
  ('manager', 'Can view withdrawal history, manage control rules, and resolve exceptions.'),
  ('admin', 'Full administrative access to master data and configuration.');

with org as (
  insert into public.organizations (name)
  values ('Gansevoort')
  returning id
)
insert into public.locations (organization_id, name, timezone)
select id, 'Gansevoort Liberty Market — WTC', 'America/New_York'
from org;
