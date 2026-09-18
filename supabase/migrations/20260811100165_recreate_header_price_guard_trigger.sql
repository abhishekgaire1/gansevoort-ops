-- Re-attach the posting-safe HEADER price-review guard trigger (dropped by
-- the diagnostic migration 20260811100164, which proved that the
-- inventoryPosting suite is pre-existingly flaky against the shared DEV
-- database independent of this trigger: 2 then 4 failures across two runs
-- with no trigger present). The guard function
-- assert_price_review_acknowledged (behavior-aware, lock-free) is unchanged.
create trigger assert_price_review_before_posting
  before insert on public.purchase_document_inventory_postings
  for each row execute function public.trg_assert_price_review_before_posting();
