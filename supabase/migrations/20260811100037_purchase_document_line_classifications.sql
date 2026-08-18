-- Milestone 2A.3 (part 3 of 8): purchase_document_line_classifications +
-- the automatic staleness-invalidation trigger.
--
-- One row per (purchase_document_id, line_key) -- a SPECIFIC revision, not
-- revision_group_id, matching how purchase_document_lines itself is
-- scoped. Deliberately NOT foreign-keyed to purchase_document_lines: every
-- save on that table deletes-and-reinserts ALL of its lines (a frozen,
-- already-shipped behavior this milestone must not touch), so a hard FK
-- here would risk a shipped RPC failing at commit the moment a manager
-- removes a line that already has a classification decision. A row whose
-- line_key no longer matches any current line becomes a harmless orphan,
-- kept deliberately for history -- consistent with this codebase's general
-- bias toward retaining decision history over cascading deletes.
create table public.purchase_document_line_classifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  line_key uuid not null,
  line_number_snapshot integer,
  disposition text not null default 'UNRESOLVED',
  inventory_item_id uuid,
  spend_category_id uuid,
  matched_inventory_item_unit_id uuid references public.inventory_item_units (id),
  resolution_source text not null,
  ai_suggested_inventory_item_id uuid,
  ai_confidence numeric,
  status text not null default 'PENDING_REVIEW',
  -- Populated every time this row is written by classification logic
  -- (deterministic tier, AI, or manual confirm) with exactly the fields
  -- deemed classification-identity-relevant: vendorSku/description/
  -- packageUnit/measuredUnit. Deliberately excludes quantities and prices
  -- -- those never affect WHICH item something maps to, only how much of
  -- it -- so correcting a typo'd price must never spuriously invalidate an
  -- otherwise-correct classification. This is the exact input the
  -- invalidation trigger below compares against.
  resolved_against_snapshot jsonb,
  resolved_by_app_user_id uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_document_line_classifications_disposition_check
    check (disposition in ('INVENTORY', 'NON_INVENTORY', 'UNRESOLVED')),
  -- STALE is set ONLY by the trigger below, automatically -- never written
  -- directly by a manager action.
  constraint purchase_document_line_classifications_status_check
    check (status in ('PENDING_REVIEW', 'CONFIRMED', 'STALE')),
  constraint purchase_document_line_classifications_resolution_source_check
    check (resolution_source in ('VENDOR_SKU_MAPPING', 'VENDOR_DESCRIPTION_MAPPING', 'NORMALIZED_NAME_MATCH', 'AI_SUGGESTED', 'MANUAL')),
  constraint purchase_document_line_classifications_pd_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id),
  constraint purchase_document_line_classifications_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint purchase_document_line_classifications_ai_item_org_fk foreign key (ai_suggested_inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint purchase_document_line_classifications_spend_category_org_fk foreign key (spend_category_id, organization_id)
    references public.spend_categories (id, organization_id),
  constraint purchase_document_line_classifications_resolved_by_org_fk foreign key (resolved_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint purchase_document_line_classifications_pd_line_key unique (organization_id, purchase_document_id, line_key)
);

create index purchase_document_line_classifications_org_status_idx
  on public.purchase_document_line_classifications (organization_id, status);

create trigger purchase_document_line_classifications_set_updated_at
  before update on public.purchase_document_line_classifications
  for each row execute function public.set_updated_at();

alter table public.purchase_document_line_classifications enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- Automatic staleness invalidation
-- ============================================================
-- Purely additive to the frozen purchase_document_lines table: a fresh
-- trigger function, never a change to any existing RPC body. Because
-- EVERY save path that touches lines (draft save, review-correction save,
-- the atomic submit path, the atomic reviewer-correct-and-verify path)
-- already deletes all lines and re-inserts them, one trigger on the
-- INSERT side catches every path uniformly, with zero knowledge of which
-- RPC caused it.
--
-- Every single save re-inserts every line whether or not that specific
-- line's own data changed -- so this function must compare VALUES against
-- the classification's own stored resolved_against_snapshot, never just
-- react to "a line was (re)inserted." Reacting to the reinsert alone would
-- invalidate classifications on every unrelated save (e.g. a header-total
-- correction) and defeat the "usually resolves instantly with zero new AI
-- calls" design.
create or replace function public.invalidate_stale_line_classification()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_classification record;
  v_new_snapshot jsonb;
begin
  select id, resolved_against_snapshot
    into v_classification
    from public.purchase_document_line_classifications
   where organization_id = new.organization_id
     and purchase_document_id = new.purchase_document_id
     and line_key = new.line_key;

  if not found then
    -- No classification exists yet for this line -- nothing to
    -- invalidate. It will be classified for the first time by the normal
    -- (re-)resolution flow.
    return new;
  end if;

  v_new_snapshot := jsonb_build_object(
    'vendorSku', new.vendor_sku,
    'description', new.description,
    'packageUnit', new.package_unit,
    'measuredUnit', new.measured_unit
  );

  if v_classification.resolved_against_snapshot is not distinct from v_new_snapshot then
    -- Matches exactly what this classification was last resolved against
    -- -- the common case on every unrelated save. No-op.
    return new;
  end if;

  update public.purchase_document_line_classifications
     set status = 'STALE'
   where id = v_classification.id;

  return new;
end;
$$;

create trigger purchase_document_lines_invalidate_stale_classification
  after insert on public.purchase_document_lines
  for each row execute function public.invalidate_stale_line_classification();
