-- Recreate the posting-boundary price-review guard trigger. It was dropped
-- by the immediately preceding diagnostic migration (20260811100157) while
-- proving that four pre-existing inventoryPosting movement-value test
-- failures are unrelated to price review (a read-only BEFORE INSERT guard
-- cannot change posted movement quantities). The guard function
-- public.trg_assert_price_review_before_posting was never dropped; this
-- reattaches it to the single posting-boundary table.
create trigger assert_price_review_before_posting
  before insert on public.purchase_document_inventory_postings
  for each row execute function public.trg_assert_price_review_before_posting();
