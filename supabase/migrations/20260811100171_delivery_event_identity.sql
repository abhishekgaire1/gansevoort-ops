-- Durable delivery-event identity for receipts.
--
-- Duplicate-delivery incident (Bartlett #3776989): the same physical delivery
-- was recorded three times as independent DELIVERY receipts (distinct per-
-- session idempotency keys), each carrying all lines, so posting/price summed
-- them (84 -> 252). Idempotency keys already dedupe true retries WITHIN a
-- session, but nothing identified "the same physical delivery" across sessions.
--
-- This adds an explicit, set-once delivery_event_id on receipts:
--   * a DELIVERY carries the event id supplied by the client (one stable id per
--     intended physical delivery; a genuine additional delivery gets a NEW id);
--   * a CORRECTION inherits the event id of the receipt it corrects, so a whole
--     correction chain resolves to one physical delivery;
--   * a DELIVERY submitted again with the same (org, document, event id) returns
--     the EXISTING receipt (idempotent) instead of creating a duplicate;
--   * a partial unique index enforces one DELIVERY per (org, document, event id).
-- The column is immutable (receipts stay append-only -- set at INSERT, never
-- updated). Historical receipts keep delivery_event_id NULL; the readiness/
-- posting classifier treats multiple effective DELIVERY roots without distinct
-- non-null event ids as AMBIGUOUS and blocks posting (never guesses a quantity).
--
-- record_receipt below is reproduced verbatim from 20260811100073 with ONLY the
-- delivery-event additions (new param, correction inheritance, DELIVERY
-- return-existing, insert column). No other behavior changes.

alter table public.receipts add column delivery_event_id uuid;

-- One current DELIVERY per (organization, document, delivery event). Corrections
-- (which inherit the id) are excluded so a corrected delivery is not a conflict.
create unique index receipts_org_pd_delivery_event_key
  on public.receipts (organization_id, purchase_document_id, delivery_event_id)
  where receipt_kind = 'DELIVERY' and delivery_event_id is not null;

create or replace function public.record_receipt(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_receipt_kind text,
  p_purchase_document_id uuid default null,
  p_corrects_receipt_id uuid default null,
  p_default_location_id uuid default null,
  p_notes text default null,
  p_lines jsonb default '[]'::jsonb,
  p_idempotency_key text default null
  , p_delivery_event_id uuid default null
)
returns table (
  out_receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery_event_id uuid;
  v_receipt_id uuid;
  v_doc_status text;
  v_doc_created_by uuid;
  v_effective_pd_id uuid;
  v_source_document_id uuid;
  v_verifier uuid;
  v_existing_receipt_id uuid;
  v_line jsonb;
  v_matched_line_key uuid;
  v_classification record;
  v_received_qty numeric;
  v_received_unit text;
  v_client_verified_qty numeric;
  v_server_verified_qty numeric;
  v_server_verified_unit_id uuid;
begin
  if p_receipt_kind not in ('DELIVERY', 'CORRECTION') then
    raise exception 'invalid receipt_kind %', p_receipt_kind;
  end if;

  -- Milestone 2A.5 (20260811100073): every location a receiving line
  -- targets must be an active, STORAGE-eligible location -- never a
  -- site/business location a station merely belongs to. Checked once,
  -- covering both p_default_location_id and every line's own locationId,
  -- before anything is written.
  if p_default_location_id is not null and not exists (
    select 1 from public.locations
     where id = p_default_location_id and organization_id = p_organization_id and is_active and is_storage_eligible
  ) then
    raise exception 'location % is not an active storage-eligible location in organization %', p_default_location_id, p_organization_id
      using errcode = 'GA021';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value)
     where line.value ->> 'locationId' is not null
       and not exists (
             select 1 from public.locations
              where id = (line.value ->> 'locationId')::uuid
                and organization_id = p_organization_id
                and is_active
                and is_storage_eligible
           )
  ) then
    raise exception 'one or more receiving lines target a location that is not an active storage-eligible location in organization %', p_organization_id
      using errcode = 'GA021';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_receipt_id
      from public.receipts
     where organization_id = p_organization_id
       and idempotency_key = p_idempotency_key;

    if found then
      -- A genuine replay of an already-recorded request -- return the
      -- SAME receipt, insert nothing new.
      return query select v_existing_receipt_id;
      return;
    end if;
  end if;

  if p_receipt_kind = 'CORRECTION' then
    if p_corrects_receipt_id is null then
      raise exception 'corrects_receipt_id is required for a CORRECTION receipt';
    end if;

    select purchase_document_id, delivery_event_id into v_effective_pd_id, v_delivery_event_id
      from public.receipts
     where id = p_corrects_receipt_id and organization_id = p_organization_id;

    if not found then
      raise exception 'receipt % not found', p_corrects_receipt_id
        using errcode = 'GA012';
    end if;

    -- Reviewer receiving-correction window: during READY_FOR_VERIFICATION
    -- a CORRECTION is the sanctioned Manager 2 path -- but never for the
    -- preparer (the same no-self-review rule as verify itself), and the
    -- trigger capability is granted only here, so VERIFIED/DISCARDED
    -- corrections remain blocked exactly as before.
    select status, created_by_app_user_id into v_doc_status, v_doc_created_by
      from public.purchase_documents
     where id = v_effective_pd_id and organization_id = p_organization_id;

    if v_doc_status = 'READY_FOR_VERIFICATION' then
      if v_doc_created_by = p_app_user_id then
        raise exception 'app_user % prepared purchase_document % and cannot review-correct its receiving', p_app_user_id, v_effective_pd_id
          using errcode = 'GA004';
      end if;
      perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
    end if;
  else
    if p_purchase_document_id is null then
      raise exception 'purchase_document_id is required for a DELIVERY receipt';
    end if;

    if not exists (select 1 from public.purchase_documents where id = p_purchase_document_id and organization_id = p_organization_id) then
      raise exception 'purchase_document % not found', p_purchase_document_id
        using errcode = 'GA012';
    end if;

    v_effective_pd_id := p_purchase_document_id;
    v_delivery_event_id := p_delivery_event_id;
    if p_delivery_event_id is not null then
      select id into v_existing_receipt_id
        from public.receipts
       where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id
         and receipt_kind = 'DELIVERY' and delivery_event_id = p_delivery_event_id;
      if found then
        return query select v_existing_receipt_id;
        return;
      end if;
    end if;
  end if;

  select source_document_id into v_source_document_id
    from public.purchase_documents
   where id = v_effective_pd_id;

  v_verifier := public.current_document_delivery_verifier_employee_id(v_source_document_id, p_organization_id);

  v_receipt_id := gen_random_uuid();

  begin
    insert into public.receipts (
      id, organization_id, purchase_document_id, receipt_kind, corrects_receipt_id,
      default_location_id, delivery_verified_by_employee_id_snapshot, recorded_by_app_user_id, notes, idempotency_key, delivery_event_id
    ) values (
      v_receipt_id, p_organization_id, v_effective_pd_id, p_receipt_kind, p_corrects_receipt_id,
      p_default_location_id, v_verifier, p_app_user_id, p_notes, p_idempotency_key, v_delivery_event_id
    );
  exception when unique_violation then
    -- Lost a genuine race against another caller using the same key --
    -- the winner's row is now visible; return it rather than erroring.
    if p_idempotency_key is not null then
      select id into v_existing_receipt_id
        from public.receipts
       where organization_id = p_organization_id
         and idempotency_key = p_idempotency_key;
      if found then
        return query select v_existing_receipt_id;
        return;
      end if;
    end if;
    raise;
  end;

  -- FIXED_CONVERSION integrity: recompute/validate each line's verified
  -- base quantity server-side, per line, rather than trusting the
  -- client's math. SAME_UNIT/MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY
  -- lines (no resolvable purchase-unit conversion row) fall through
  -- completely untouched.
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as t(value)
  loop
    v_matched_line_key := nullif(v_line ->> 'matchedLineKey', '')::uuid;
    v_server_verified_qty := null;
    v_server_verified_unit_id := null;

    if v_matched_line_key is not null then
      select ii.base_unit_id, bu.code as base_unit_code,
             pu.code as purchase_unit_code, piu.conversion_factor
        into v_classification
        from public.purchase_document_line_classifications c
        join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = c.organization_id
        join public.units bu on bu.id = ii.base_unit_id
        left join public.inventory_item_units piu
          on piu.inventory_item_id = ii.id and piu.unit_id <> ii.base_unit_id and piu.requires_actual_measurement = false
        left join public.units pu on pu.id = piu.unit_id
       where c.purchase_document_id = v_effective_pd_id
         and c.organization_id = p_organization_id
         and c.line_key = v_matched_line_key
         and c.status = 'CONFIRMED'
         and c.disposition = 'INVENTORY';

      if found and v_classification.purchase_unit_code is not null and v_classification.conversion_factor is not null then
        v_received_qty := (v_line ->> 'actualReceivedPackageQuantity')::numeric;
        v_received_unit := v_line ->> 'actualReceivedPackageUnit';
        v_client_verified_qty := nullif(v_line ->> 'actualVerifiedBaseQuantity', '')::numeric;

        if v_received_qty is not null and v_received_unit is not null then
          if lower(btrim(v_received_unit)) = lower(btrim(v_classification.purchase_unit_code)) then
            v_server_verified_qty := v_received_qty * v_classification.conversion_factor;
          elsif lower(btrim(v_received_unit)) = lower(btrim(v_classification.base_unit_code)) then
            v_server_verified_qty := v_received_qty;
          else
            raise exception 'line % received unit "%" does not match the item''s purchase unit (%) or base unit (%) -- cannot verify a FIXED_CONVERSION quantity',
              v_matched_line_key, v_received_unit, v_classification.purchase_unit_code, v_classification.base_unit_code
              using errcode = 'GA015';
          end if;

          if v_client_verified_qty is not null and v_client_verified_qty <> v_server_verified_qty then
            raise exception 'line % verified quantity % is inconsistent with % % at 1 % = % % -- expected %',
              v_matched_line_key, v_client_verified_qty, v_received_qty, v_received_unit,
              v_classification.purchase_unit_code, v_classification.conversion_factor, v_classification.base_unit_code, v_server_verified_qty
              using errcode = 'GA015';
          end if;

          v_server_verified_unit_id := v_classification.base_unit_id;
        end if;
      end if;
    end if;

    insert into public.receipt_lines (
      id, receipt_id, organization_id, line_number_snapshot, matched_line_key,
      vendor_sku_snapshot, description_snapshot,
      invoice_package_quantity, invoice_package_unit, invoice_measured_quantity, invoice_measured_unit,
      actual_received_package_quantity, actual_received_package_unit,
      actual_verified_base_quantity, actual_verified_base_unit_id,
      location_id, condition_status, notes
    ) values (
      gen_random_uuid(), v_receipt_id, p_organization_id,
      (v_line ->> 'lineNumberSnapshot')::integer,
      v_matched_line_key,
      v_line ->> 'vendorSkuSnapshot', v_line ->> 'descriptionSnapshot',
      (v_line ->> 'invoicePackageQuantity')::numeric, v_line ->> 'invoicePackageUnit',
      (v_line ->> 'invoiceMeasuredQuantity')::numeric, v_line ->> 'invoiceMeasuredUnit',
      (v_line ->> 'actualReceivedPackageQuantity')::numeric, v_line ->> 'actualReceivedPackageUnit',
      -- FIXED_CONVERSION lines: always the server's own recomputed value
      -- (never the raw client one, even when it agreed). Every other
      -- line: passed through exactly as submitted, unchanged.
      coalesce(v_server_verified_qty, (v_line ->> 'actualVerifiedBaseQuantity')::numeric),
      coalesce(v_server_verified_unit_id, (v_line ->> 'actualVerifiedBaseUnitId')::uuid),
      (v_line ->> 'locationId')::uuid,
      coalesce(v_line ->> 'conditionStatus', 'RECEIVED_AS_INVOICED'),
      v_line ->> 'notes'
    );
  end loop;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'RECEIPT_RECORDED', 'purchase_document', v_effective_pd_id,
    jsonb_build_object(
      'receiptId', v_receipt_id, 'receiptKind', p_receipt_kind, 'correctsReceiptId', p_corrects_receipt_id,
      'deliveryVerifiedByEmployeeId', v_verifier
    ));

  return query select v_receipt_id;
end;
$$;

revoke all on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, text, uuid) from public;
grant execute on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, text, uuid) to service_role;
