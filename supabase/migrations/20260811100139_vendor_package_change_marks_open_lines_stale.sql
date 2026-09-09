-- Safe editing of confirmed items with inventory-impact protection (Part 4).
--
-- Spec requirement: "identify open/unposted documents using [an edited]
-- item... do not silently mark an already-completed line ready if the
-- new configuration creates a mismatch." An open (DRAFT/READY_FOR_
-- VERIFICATION) purchase-document line that was already CONFIRMED
-- against a specific vendor_item_purchase_units version must reopen for
-- review the moment that version is superseded by a standalone package
-- edit (manager_set_vendor_purchase_package, 20260811100140) -- otherwise
-- the line would silently post using a stale, no-longer-current factor
-- the next time the document is submitted.
--
-- Reuses the EXISTING STALE status/mechanism verbatim
-- (invalidate_stale_line_classification, 20260811100037) rather than
-- inventing a second revalidation concept -- this is just a second
-- trigger, on a different source table, that can also set status =
-- 'STALE'. A VERIFIED document's classifications are untouched: they are
-- immutable regardless of what happens to the package afterward (the
-- correction for an already-posted receipt is the separate, explicit
-- correct_receipt_package_factor workflow, 20260811100142 -- never this
-- trigger).
--
-- upsert_vendor_item_purchase_unit (20260811100120/100131) always
-- supersedes in two steps within one transaction: UPDATE the old active
-- row (is_active=false, superseded_by_purchase_unit_id = <new id>) THEN
-- INSERT the new row. This trigger only needs OLD.id -- it reacts to an
-- existing package version BEING superseded, not to anything about the
-- new version, so it is correct regardless of transaction-internal
-- ordering (the new row's own FK is deferred to commit, but this trigger
-- never reads the new row at all).
create or replace function public.mark_open_lines_stale_on_package_supersede()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.superseded_by_purchase_unit_id is not null and old.superseded_by_purchase_unit_id is null then
    update public.purchase_document_line_classifications c
       set status = 'STALE'
      from public.purchase_documents pd
     where c.vendor_item_purchase_unit_id = old.id
       and c.status = 'CONFIRMED'
       and pd.id = c.purchase_document_id
       and pd.organization_id = c.organization_id
       and pd.status in ('DRAFT', 'READY_FOR_VERIFICATION');
  end if;
  return new;
end;
$$;

create trigger vendor_item_purchase_units_mark_open_lines_stale
  after update on public.vendor_item_purchase_units
  for each row execute function public.mark_open_lines_stale_on_package_supersede();
