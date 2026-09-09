-- Safe editing of confirmed items with inventory-impact protection (Part 3).
--
-- purchase_document_line_classifications has no index on
-- inventory_item_id today (only (organization_id, status) from
-- 20260811100037) -- fine when the only reads are "lines for THIS
-- document," but the new Edit-Item/Archive dependency checks
-- (20260811100143) and the vendor-package supersede trigger
-- (20260811100139) both need "open lines for THIS ITEM across every
-- document," a query pattern that didn't exist before this feature.

create index purchase_document_line_classifications_item_idx
  on public.purchase_document_line_classifications (organization_id, inventory_item_id)
  where inventory_item_id is not null;
