-- Cycle Count integration with Inventory Waste, Phase F: the atomic,
-- SAFE record-and-re-anchor operation (Part 26/27). This is the ONLY
-- place a cycle-count-identified waste actually posts to the ledger --
-- mark_cycle_count_line_known_waste (20260811100086) is provisional only
-- and never writes inventory_waste_events or a WASTE movement.
--
-- Calls record_inventory_waste(...) directly (20260811100085, extended
-- with optional p_cycle_count_id/p_cycle_count_line_id) to reuse its
-- locking/idempotency/insert logic rather than duplicating it -- a
-- plpgsql function call does not start a new transaction, so this stays
-- one atomic unit with everything else this function does.
create function public.record_cycle_count_line_waste(
  p_cycle_count_id uuid,
  p_inventory_item_id uuid,
  p_reason_code text,
  p_note text,
  p_actor_app_user_id uuid,
  p_client_request_id uuid
) returns table (
  out_waste_event_id uuid,
  out_cycle_count_line_id uuid,
  out_quantity numeric,
  out_unit_code text,
  out_new_expected_quantity numeric,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_location_id uuid;
  v_status text;
  v_owner uuid;
  v_line_id uuid;
  v_identified_quantity numeric;
  v_ledger_count_snapshot integer;
  v_existing_waste_event_id uuid;
  v_current_ledger_count integer;
  v_existing record;
  v_waste_result record;
  v_new_expected numeric;
  v_new_ledger_count integer;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_actor_app_user_id and au.is_active;

  if not found then
    raise exception 'actor_app_user_id % is not an active app user', p_actor_app_user_id;
  end if;

  -- Step 1/2: lock the cycle count row, verify DRAFT + ownership --
  -- identical gate to complete_cycle_count/mark_cycle_count_line_known_
  -- waste, and this SAME row lock is what makes a double-click/retry
  -- against the SAME line safe even before the item/location lock below:
  -- a second concurrent call blocks here until the first commits, then
  -- observes the now-resolved line and takes the replay/conflict branch.
  select location_id, status, started_by_app_user_id into v_location_id, v_status, v_owner
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id
     for update;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'cycle_count_id % is % and is not open for counting', p_cycle_count_id, v_status
      using errcode = 'GA003';
  end if;
  if v_owner is distinct from p_actor_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
  end if;

  select id, identified_waste_quantity, ledger_line_count_at_snapshot, waste_event_id
    into v_line_id, v_identified_quantity, v_ledger_count_snapshot, v_existing_waste_event_id
    from public.inventory_cycle_count_lines
   where cycle_count_id = p_cycle_count_id and inventory_item_id = p_inventory_item_id;

  if not found then
    raise exception 'inventory_item_id % has not been added to cycle_count_id % yet', p_inventory_item_id, p_cycle_count_id;
  end if;

  if v_identified_quantity is null then
    raise exception 'cycle_count_line % has no identified waste quantity to record', v_line_id;
  end if;

  -- Idempotency (Part "recording same identified waste twice is
  -- idempotent/no duplicate"): a line can only ever be resolved once
  -- (Part 37 -- one known-waste record per line). If already resolved,
  -- the SAME client_request_id replays the original result; a
  -- DIFFERENT one is a genuinely distinct second attempt against an
  -- already-posted line and fails closed.
  if v_existing_waste_event_id is not null then
    select we.client_request_id as existing_client_request_id, we.id as existing_waste_event_id,
           we.quantity as existing_quantity, we.unit_code as existing_unit_code
      into v_existing
      from public.inventory_waste_events we
     where we.id = v_existing_waste_event_id;

    if v_existing.existing_client_request_id is distinct from p_client_request_id then
      raise exception 'cycle_count_line % already has recorded waste', v_line_id
        using errcode = 'GA031';
    end if;

    return query select
      v_existing.existing_waste_event_id, v_line_id, v_existing.existing_quantity, v_existing.existing_unit_code,
      (select l.expected_quantity_at_snapshot from public.inventory_cycle_count_lines l where l.id = v_line_id),
      true;
    return;
  end if;

  -- Step 3/4: lock (org, item, location), THEN verify the watermark this
  -- line was counted against is STILL the current one (Part 26). If
  -- unrelated activity happened since the manager counted this item,
  -- blindly posting and re-anchoring would risk exactly the kind of
  -- silent double-adjustment this whole safety design exists to prevent
  -- -- refuse and require a recount instead. Zero waste is written when
  -- this fires (the exception rolls back everything in this call).
  perform pg_advisory_xact_lock(public.inventory_location_lock_key(v_org_id, p_inventory_item_id, v_location_id));

  select public.inventory_location_item_ledger_line_count(v_org_id, p_inventory_item_id, v_location_id)
    into v_current_ledger_count;

  if v_current_ledger_count <> v_ledger_count_snapshot then
    raise exception 'cycle_count_line % changed since it was counted and must be recounted', v_line_id
      using errcode = 'GA030';
  end if;

  -- Step 5/6/7/8/9: validate + create the Inventory Waste event and its
  -- WASTE movement/line, via the SAME function standalone waste uses --
  -- same quantity validation, same insufficient-inventory guard, same
  -- idempotency table. p_cycle_count_id/p_cycle_count_line_id link this
  -- event back to this exact line (Part 15).
  select * into v_waste_result
    from public.record_inventory_waste(
      p_actor_app_user_id, v_location_id, p_inventory_item_id, v_identified_quantity,
      p_reason_code, p_note, p_client_request_id, p_cycle_count_id, v_line_id
    );

  -- Step 10/11/12/13: re-read the POST-waste authoritative balance and
  -- ledger watermark, and re-anchor this line to them -- this is the
  -- controlled re-anchor Part 27 describes, safe specifically because
  -- the ONLY ledger change since the pre-waste snapshot was verified
  -- above is the WASTE posting this call itself just made.
  -- physical_count_quantity is never touched (Part 27 step 13 -- the
  -- manager's physical observation is preserved exactly).
  select public.inventory_location_item_balance(v_org_id, p_inventory_item_id, v_location_id) into v_new_expected;
  select public.inventory_location_item_ledger_line_count(v_org_id, p_inventory_item_id, v_location_id) into v_new_ledger_count;

  update public.inventory_cycle_count_lines
     set expected_quantity_at_snapshot = v_new_expected,
         ledger_line_count_at_snapshot = v_new_ledger_count,
         waste_event_id = v_waste_result.out_waste_event_id,
         waste_resolved_at = now()
   where id = v_line_id;

  return query select
    v_waste_result.out_waste_event_id, v_line_id, v_waste_result.out_quantity, v_waste_result.out_unit_code,
    v_new_expected, false;
end;
$$;

revoke all on function public.record_cycle_count_line_waste(uuid, uuid, text, text, uuid, uuid) from public;
grant execute on function public.record_cycle_count_line_waste(uuid, uuid, text, text, uuid, uuid) to service_role;
