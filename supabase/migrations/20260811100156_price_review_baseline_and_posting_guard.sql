-- Hardening pass for vendor-aware price-change review:
--  (1) a SKU/currency/base-unit/date-correct comparable-baseline selector,
--      shared by Step 2, Step 3, and the posting guard so they cannot drift;
--  (2) a transactional posting-boundary guard enforced by a trigger on the
--      single table every posting path writes -- so a stale/missing
--      acknowledgment of a significant price change fails closed at the
--      authoritative database boundary, not merely in a server action.
--
-- Does NOT edit 100106/100149/100155. The list-style price-history RPC
-- (get_inventory_item_price_history) is unchanged and still backs the Price
-- History page; the new selector below is built on the SAME posted-line
-- source, so there is one price definition, not two.

-- ============================================================
-- 1. Currency normalization -- one shared rule ($ -> USD, trim/upper).
-- ============================================================
create or replace function public.normalize_currency_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_code is null then null
    when btrim(p_code) = '' then null
    when btrim(p_code) in ('$', 'usd', 'USD', 'Usd') then 'USD'
    else upper(btrim(p_code))
  end;
$$;

-- ============================================================
-- 2. Comparable-price baseline. Returns AT MOST the single most-recent
-- eligible POSTED purchase event that matches org + item + vendor + SKU
-- (when the current line has one) + normalized currency + base unit, dated
-- on/before the current invoice's effective date, excluding the current
-- document and its own amendment lineage. Empty when none qualifies.
-- ============================================================
create or replace function public.get_comparable_price_baseline(
  p_organization_id uuid,
  p_vendor_id uuid,
  p_inventory_item_id uuid,
  p_vendor_sku text,
  p_currency_code text,
  p_base_unit_code text,
  p_before_date date,
  p_exclude_purchase_document_id uuid
)
returns table (
  out_purchase_document_id uuid,
  out_document_number text,
  out_document_date date,
  out_vendor_id uuid,
  out_vendor_name text,
  out_line_total numeric,
  out_base_quantity numeric,
  out_base_unit_code text,
  out_unit_cost numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with excluded_group as (
    select revision_group_id from public.purchase_documents where id = p_exclude_purchase_document_id
  ),
  posted as (
    select
      pd.id as purchase_document_id,
      pd.document_number,
      pd.document_date,
      pd.vendor_id,
      v.name as vendor_name,
      pdl.line_total,
      sum(pil.posted_base_quantity) as base_quantity,
      max(u.code) as base_unit_code
    from public.purchase_document_inventory_posting_lines pil
    join public.purchase_document_inventory_postings pdp
      on pdp.id = pil.posting_id and pdp.organization_id = p_organization_id
    join public.purchase_documents pd
      on pd.id = pdp.purchase_document_id and pd.organization_id = p_organization_id
    join public.vendors v
      on v.id = pd.vendor_id and v.organization_id = p_organization_id
    join public.receipt_lines rl
      on rl.id = pil.receipt_line_id and rl.organization_id = p_organization_id
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = pd.id and pdl.organization_id = p_organization_id and pdl.line_key = rl.matched_line_key
    join public.units u on u.id = pil.base_unit_id
    where pil.organization_id = p_organization_id
      and pil.inventory_item_id = p_inventory_item_id
      and pd.vendor_id = p_vendor_id
      and pdl.line_total is not null
      and pdl.line_total > 0
      -- Same normalized currency (never blend currencies).
      and public.normalize_currency_code(pd.currency) is not distinct from public.normalize_currency_code(p_currency_code)
      -- SKU rule: match when the current line has a SKU; when it has none,
      -- only a genuinely SKU-less historical event qualifies. Never fall
      -- back to another SKU from the same vendor.
      and (
        (p_vendor_sku is null and pdl.vendor_sku is null)
        or (p_vendor_sku is not null and upper(btrim(pdl.vendor_sku)) = upper(btrim(p_vendor_sku)))
      )
      -- Effective-date convention: on/before the current invoice's date.
      and (p_before_date is null or pd.document_date <= p_before_date)
      -- Exclude the current document and its whole amendment lineage.
      and pd.id is distinct from p_exclude_purchase_document_id
      and pd.revision_group_id is distinct from (select revision_group_id from excluded_group)
    group by pd.id, pd.document_number, pd.document_date, pd.vendor_id, v.name, pdl.line_total
  ),
  ranked as (
    select posted.*,
           case when base_quantity > 0 then line_total / base_quantity else null end as unit_cost,
           row_number() over (order by document_date desc nulls last, purchase_document_id desc) as rnk
    from posted
    where base_unit_code = p_base_unit_code  -- same authoritative base unit
  )
  select purchase_document_id, document_number, document_date, vendor_id, vendor_name,
         line_total, base_quantity, base_unit_code, unit_cost
  from ranked
  where rnk = 1 and unit_cost is not null and unit_cost > 0;
$$;

revoke all on function public.get_comparable_price_baseline(uuid, uuid, uuid, text, text, text, date, uuid) from public;
grant execute on function public.get_comparable_price_baseline(uuid, uuid, uuid, text, text, text, date, uuid) to service_role;

-- ============================================================
-- 3. Transactional posting guard. Recomputes, from database values only,
-- every inventory line's normalized current price against its comparable
-- baseline; any >= 20% change requires a stored acknowledgment whose
-- previous/current normalized prices and the selected prior event still
-- match. Raises GA079 (fail closed) otherwise. Never trusts client input.
-- ============================================================
create or replace function public.assert_price_review_acknowledged(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_before date;
  v_vendor_id uuid;
  v_violations integer;
begin
  -- Serialize with concurrent document mutations (fail closed under races).
  perform 1 from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id
   for no key update;

  select public.normalize_currency_code(currency), document_date, vendor_id
    into v_currency, v_before, v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  with cur as (
    select
      c.line_key,
      c.inventory_item_id,
      pdl.vendor_sku,
      ii.base_unit_id,
      bu.code as base_unit_code,
      pdl.line_total,
      sum(rl.actual_verified_base_quantity) as base_qty
    from public.purchase_document_line_classifications c
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = p_purchase_document_id
     and pdl.organization_id = p_organization_id
     and pdl.line_key = c.line_key
    join public.inventory_items ii
      on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
    join public.units bu on bu.id = ii.base_unit_id
    join public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er on true
    join public.receipt_lines rl
      on rl.receipt_id = er.id and rl.organization_id = p_organization_id and rl.matched_line_key = c.line_key
    where c.organization_id = p_organization_id
      and c.purchase_document_id = p_purchase_document_id
      and c.status = 'CONFIRMED'
      and c.disposition = 'INVENTORY'
      and c.inventory_item_id is not null
    group by c.line_key, c.inventory_item_id, pdl.vendor_sku, ii.base_unit_id, bu.code, pdl.line_total
  ),
  priced as (
    select cur.*,
           case when cur.base_qty > 0 and cur.line_total > 0 then cur.line_total / cur.base_qty else null end as current_unit_cost
    from cur
  ),
  compared as (
    select priced.*, b.out_purchase_document_id as prev_pd, b.out_unit_cost as prev_unit_cost,
           case when priced.current_unit_cost is not null and b.out_unit_cost is not null and b.out_unit_cost <> 0
                then abs((priced.current_unit_cost - b.out_unit_cost) / b.out_unit_cost) * 100 else null end as delta_pct
    from priced
    left join lateral public.get_comparable_price_baseline(
      p_organization_id, v_vendor_id, priced.inventory_item_id, priced.vendor_sku, v_currency, priced.base_unit_code, v_before, p_purchase_document_id
    ) b on true
    where priced.current_unit_cost is not null
  )
  select count(*) into v_violations
  from compared
  where delta_pct is not null and delta_pct >= 20
    and not exists (
      select 1 from public.price_change_acknowledgments a
       where a.organization_id = p_organization_id
         and a.purchase_document_id = p_purchase_document_id
         and a.line_key = compared.line_key
         and a.inventory_item_id = compared.inventory_item_id
         and a.vendor_id = v_vendor_id
         and public.normalize_currency_code(a.currency) is not distinct from v_currency
         and (upper(btrim(coalesce(a.vendor_sku, ''))) = upper(btrim(coalesce(compared.vendor_sku, ''))))
         and a.previous_purchase_document_id is not distinct from compared.prev_pd
         and round(a.previous_unit_cost, 6) = round(compared.prev_unit_cost, 6)
         and round(a.current_unit_cost, 6) = round(compared.current_unit_cost, 6)
    );

  if v_violations > 0 then
    raise exception 'This invoice contains a significant price change that must be reviewed again before inventory can be posted.'
      using errcode = 'GA079';
  end if;
end;
$$;

revoke all on function public.assert_price_review_acknowledged(uuid, uuid) from public;
grant execute on function public.assert_price_review_acknowledged(uuid, uuid) to service_role;

-- ============================================================
-- 4. Enforce at the single posting-boundary table. Every posting path
-- (normal verify-post, sole-approver, additional-delivery, any future one)
-- inserts a purchase_document_inventory_postings header row -- this
-- BEFORE INSERT trigger runs the guard in the SAME transaction, so a direct
-- RPC call cannot bypass it.
-- ============================================================
create or replace function public.trg_assert_price_review_before_posting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_price_review_acknowledged(new.purchase_document_id, new.organization_id);
  return new;
end;
$$;

create trigger assert_price_review_before_posting
  before insert on public.purchase_document_inventory_postings
  for each row execute function public.trg_assert_price_review_before_posting();
