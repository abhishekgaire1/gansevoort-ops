-- Fixes a real concurrency bug in 20260811100064's
-- post_purchase_document_inventory, caught by the concurrent-posting
-- integration test under full-suite load.
--
-- The idempotent-replay check ran as TWO separate statements: first count
-- already-posted lines, then check for unposted candidates. Under READ
-- COMMITTED each statement takes its own snapshot, so a caller racing a
-- concurrent post could observe already_posted = 0 (winner uncommitted)
-- and then no-unposted-candidates (winner now committed) -- falling into
-- the "no postable inventory lines" GA017 branch instead of returning
-- ALREADY_POSTED. Fix: compute both counts in ONE statement (one
-- snapshot), so the only possible outcomes are exactly: blockers,
-- ALREADY_POSTED, genuinely-nothing-to-post, or proceed-to-insert (where
-- the unique receipt_line_id backstop already resolves the direct insert
-- race). Body-only replace, same signature.
create or replace function public.post_purchase_document_inventory(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid
)
returns table (
  out_status text,
  out_posting_id uuid,
  out_posted_line_count integer,
  out_movement_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_status text;
  v_blockers jsonb;
  v_candidate record;
  v_location record;
  v_posting_id uuid;
  v_movement_id uuid;
  v_movement_line_id uuid;
  v_movement_count integer := 0;
  v_posted_count integer := 0;
  v_unposted_candidate_count integer;
  v_already_posted_count integer;
  v_affected record;
  v_new_balance numeric;
begin
  select status into v_doc_status
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if v_doc_status is null then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_doc_status <> 'VERIFIED' then
    raise exception 'purchase_document % is % and cannot be posted to inventory -- only a VERIFIED document can post', p_purchase_document_id, v_doc_status
      using errcode = 'GA003';
  end if;

  -- Blocker scan: every UNPOSTED effective inventory line must be fully
  -- postable, or the whole operation is refused with the exact reasons
  -- (atomic all-required-lines posting -- no accidental partial posting).
  select jsonb_agg(jsonb_build_object('lineKey', b.line_key, 'description', b.description, 'reason', b.reason))
    into v_blockers
  from (
    select rl.matched_line_key as line_key,
           coalesce(rl.description_snapshot, 'Line') as description,
           case
             when c.inventory_item_id is null then 'canonical inventory item is not resolved'
             when rl.actual_received_package_quantity is null then 'received quantity has not been recorded'
             when rl.location_id is null then 'storage location is missing'
             when rl.actual_received_package_unit is null then 'received unit is missing'
             when u.id is null then 'received unit "' || rl.actual_received_package_unit || '" is not a recognized unit'
             when iiu.id is null then 'received unit "' || rl.actual_received_package_unit || '" is not configured for this item'
             when iiu.requires_actual_measurement and rl.actual_verified_base_quantity is null
               then 'verified measurement is required -- this item varies by delivery'
             when not iiu.requires_actual_measurement and rl.actual_verified_base_quantity is not null
                  and rl.actual_verified_base_quantity <> rl.actual_received_package_quantity * iiu.conversion_factor
               then 'stored verified quantity is inconsistent with the item''s current confirmed conversion -- review before posting'
             else null
           end as reason
      from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
      join public.receipt_lines rl on rl.receipt_id = er.id
      join public.purchase_document_line_classifications c
        on c.organization_id = p_organization_id
       and c.purchase_document_id = p_purchase_document_id
       and c.line_key = rl.matched_line_key
       and c.status = 'CONFIRMED'
       and c.disposition = 'INVENTORY'
      left join public.inventory_items ii
        on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
      left join public.units u
        on upper(btrim(u.code)) = upper(btrim(coalesce(rl.actual_received_package_unit, '')))
      left join public.inventory_item_units iiu
        on iiu.inventory_item_id = c.inventory_item_id and iiu.unit_id = u.id and iiu.is_active
      left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
     where rl.matched_line_key is not null
       and pl.id is null
       and (rl.actual_received_package_quantity is null or rl.actual_received_package_quantity > 0)
  ) b
  where b.reason is not null;

  if v_blockers is not null then
    raise exception 'cannot post inventory yet -- % line(s) are not postable', jsonb_array_length(v_blockers)
      using errcode = 'GA017', detail = v_blockers::text;
  end if;

  -- ONE statement, ONE snapshot: unposted candidates and already-posted
  -- lines counted together, so a concurrent winner committing between
  -- reads can never skew the branch decision.
  select
    count(*) filter (
      where pl.id is null
        and c.status = 'CONFIRMED'
        and c.disposition = 'INVENTORY'
        and rl.actual_received_package_quantity > 0
    ),
    count(*) filter (where pl.id is not null)
    into v_unposted_candidate_count, v_already_posted_count
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
    join public.receipt_lines rl on rl.receipt_id = er.id
    left join public.purchase_document_line_classifications c
      on c.organization_id = p_organization_id
     and c.purchase_document_id = p_purchase_document_id
     and c.line_key = rl.matched_line_key
    left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
   where rl.matched_line_key is not null;

  if v_unposted_candidate_count = 0 then
    if v_already_posted_count > 0 then
      select id into v_posting_id
        from public.purchase_document_inventory_postings
       where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id
       order by posted_at desc limit 1;
      return query select 'ALREADY_POSTED'::text, v_posting_id, 0, 0;
      return;
    end if;
    raise exception 'purchase_document % has no postable inventory lines', p_purchase_document_id
      using errcode = 'GA017';
  end if;

  -- All checks passed -- post atomically. The unique receipt_line_id
  -- backstop makes two concurrent posts converge: the loser's entire
  -- posting work rolls back (this EXCEPTION block is a subtransaction)
  -- and it reports the winner's posting instead.
  begin
    insert into public.purchase_document_inventory_postings (organization_id, purchase_document_id, posted_by_app_user_id)
    values (p_organization_id, p_purchase_document_id, p_app_user_id)
    returning id into v_posting_id;

    -- One movement per distinct storage location in this posting.
    for v_location in
      select distinct rl.location_id, loc.timezone
        from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
        join public.receipt_lines rl on rl.receipt_id = er.id
        join public.purchase_document_line_classifications c
          on c.organization_id = p_organization_id
         and c.purchase_document_id = p_purchase_document_id
         and c.line_key = rl.matched_line_key
         and c.status = 'CONFIRMED'
         and c.disposition = 'INVENTORY'
        join public.locations loc on loc.id = rl.location_id
        left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
       where rl.matched_line_key is not null
         and pl.id is null
         and rl.actual_received_package_quantity > 0
    loop
      insert into public.inventory_movements (
        organization_id, location_id, station_id, movement_type,
        performed_by_app_user_id, business_date
      ) values (
        p_organization_id, v_location.location_id, null, 'PURCHASE_RECEIPT',
        p_app_user_id, (now() at time zone v_location.timezone)::date
      ) returning id into v_movement_id;
      v_movement_count := v_movement_count + 1;

      for v_candidate in
        select rl.id as receipt_line_id,
               c.inventory_item_id,
               rl.actual_received_package_quantity as entered_quantity,
               u.id as entered_unit_id,
               iiu.requires_actual_measurement,
               rl.actual_verified_base_quantity
          from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
          join public.receipt_lines rl on rl.receipt_id = er.id
          join public.purchase_document_line_classifications c
            on c.organization_id = p_organization_id
           and c.purchase_document_id = p_purchase_document_id
           and c.line_key = rl.matched_line_key
           and c.status = 'CONFIRMED'
           and c.disposition = 'INVENTORY'
          join public.units u on upper(btrim(u.code)) = upper(btrim(rl.actual_received_package_unit))
          join public.inventory_item_units iiu
            on iiu.inventory_item_id = c.inventory_item_id and iiu.unit_id = u.id and iiu.is_active
          left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
         where rl.matched_line_key is not null
           and pl.id is null
           and rl.actual_received_package_quantity > 0
           and rl.location_id = v_location.location_id
      loop
        -- enforce_movement_line_measurement computes organization_id,
        -- base_unit_id, and normalized_base_quantity authoritatively --
        -- fixed conversions are recomputed from the item's CURRENT
        -- confirmed factor (never a stale client value), and measured
        -- items use the manager's verified actual quantity.
        insert into public.inventory_movement_lines (
          movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
        ) values (
          v_movement_id, v_candidate.inventory_item_id, v_candidate.entered_quantity, v_candidate.entered_unit_id,
          case when v_candidate.requires_actual_measurement then v_candidate.actual_verified_base_quantity else null end
        ) returning id into v_movement_line_id;

        insert into public.purchase_document_inventory_posting_lines (
          organization_id, posting_id, receipt_line_id, movement_id, movement_line_id,
          inventory_item_id, location_id, posted_base_quantity, base_unit_id
        )
        select p_organization_id, v_posting_id, v_candidate.receipt_line_id, v_movement_id, ml.id,
               ml.inventory_item_id, v_location.location_id, ml.normalized_base_quantity, ml.base_unit_id
          from public.inventory_movement_lines ml
         where ml.id = v_movement_line_id;

        v_posted_count := v_posted_count + 1;
      end loop;
    end loop;

    -- Every genuine restock sets the POST-restock balance as the new 100%
    -- reference for each affected item+location (product rule 13). The
    -- balance function sees this transaction's own uncommitted rows.
    for v_affected in
      select distinct pl.inventory_item_id, pl.location_id, pl.base_unit_id
        from public.purchase_document_inventory_posting_lines pl
       where pl.posting_id = v_posting_id
    loop
      select b.out_balance into v_new_balance
        from public.inventory_location_balances(p_organization_id) b
       where b.out_inventory_item_id = v_affected.inventory_item_id
         and b.out_location_id = v_affected.location_id;

      if v_new_balance is not null and v_new_balance > 0 then
        insert into public.inventory_stock_references (
          organization_id, inventory_item_id, location_id, full_quantity, base_unit_id,
          source, set_by_app_user_id, source_posting_id
        ) values (
          p_organization_id, v_affected.inventory_item_id, v_affected.location_id, v_new_balance, v_affected.base_unit_id,
          'RESTOCK', p_app_user_id, v_posting_id
        );
      end if;
    end loop;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (p_organization_id, p_app_user_id, 'INVENTORY_POSTED', 'purchase_document', p_purchase_document_id,
      jsonb_build_object('postingId', v_posting_id, 'postedLineCount', v_posted_count, 'movementCount', v_movement_count));

  exception when unique_violation then
    -- A concurrent post won the race on receipt_line_id -- everything this
    -- caller inserted above is rolled back; report the winner's posting.
    select id into v_posting_id
      from public.purchase_document_inventory_postings
     where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id
     order by posted_at desc limit 1;
    return query select 'ALREADY_POSTED'::text, v_posting_id, 0, 0;
    return;
  end;

  return query select 'POSTED'::text, v_posting_id, v_posted_count, v_movement_count;
end;
$$;

revoke all on function public.post_purchase_document_inventory(uuid, uuid, uuid) from public;
grant execute on function public.post_purchase_document_inventory(uuid, uuid, uuid) to service_role;
