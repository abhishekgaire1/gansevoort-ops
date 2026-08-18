-- Adversarial-review fixes, priorities 3 (backend half) + 7.
--
-- Priority 3 (FIXED_CONVERSION receipt integrity): record_receipt
-- (20260811100041) trusted whatever actual_verified_base_quantity the
-- client sent, unvalidated. Paired with the client-side bug fixed
-- alongside this migration (ReceivingPanel.tsx's Received Qty/Unit fields
-- never recomputed the derived quantity on edit), a shortage/excess
-- correction could permanently store a wrong base-unit quantity in the
-- append-only receipt_lines table with no way for a manager to notice.
-- This migration adds the authoritative backend half: for every line
-- matched to a CURRENT CONFIRMED INVENTORY classification whose item is
-- FIXED_CONVERSION (a resolved purchase-unit row with a real, non-
-- measured conversion factor), the server independently recomputes the
-- expected base-unit quantity from actual_received_package_quantity *
-- actual_received_package_unit and the item's OWN current
-- inventory_item_units conversion factor -- never the client's math.
-- A client-supplied actual_verified_base_quantity that disagrees is
-- REJECTED (the whole record_receipt call fails, nothing partial is
-- written) rather than silently stored as a permanent contradiction; a
-- null client value is simply filled in with the server's own
-- computation. A received unit that matches neither the item's purchase
-- unit nor its base unit is also rejected outright -- there is no safe
-- guess to fall back to. MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY and
-- SAME_UNIT lines are completely untouched by this validation -- their
-- verified/received quantities remain exactly as manager-entered, per the
-- existing, correct semantics for those receiving behaviors.
--
-- Priority 7 (receipt idempotency): a double-click or network retry could
-- previously create two indistinguishable "effective" DELIVERY receipts
-- for the same document, since record_receipt had no idempotency
-- protection and "same document + same lines" is explicitly NOT a safe
-- uniqueness rule (legitimate partial/additional deliveries must remain
-- possible). Fixed with a client-generated idempotency key, following the
-- exact same proven check-then-insert-with-exception-handling shape as
-- try_claim_purchase_document_classification_run (20260811100039): if a
-- receipt with this (organization_id, idempotency_key) already exists,
-- return its id unchanged (a true idempotent replay, not an error); the
-- INSERT itself is wrapped in its own exception handler catching
-- unique_violation on the same key, so two callers racing with the same
-- key can never both create a receipt -- exactly one wins, the other
-- observes and returns the winner's row. A null key (an internal/system
-- caller that doesn't supply one) skips idempotency checking entirely,
-- preserving today's behavior for any caller that doesn't opt in.
alter table public.receipts add column if not exists idempotency_key text;

-- Partial unique index -- only receipts recorded WITH a key participate;
-- a null key is never a duplicate of any other null key.
create unique index if not exists receipts_org_idempotency_key
  on public.receipts (organization_id, idempotency_key)
  where idempotency_key is not null;

-- Dropped BEFORE the new signature is created, not after -- the new
-- 9th parameter has a default, so an 8-argument call would satisfy BOTH
-- signatures if they ever coexisted, which raises Postgres's "function is
-- not unique" ambiguity error. Same overload-ambiguity lesson already
-- applied repeatedly elsewhere in this migration sequence (e.g.
-- 20260811100043/100052) -- drop-then-create, never create-then-drop.
drop function if exists public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb);

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
)
returns table (
  out_receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_id uuid;
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

    select purchase_document_id into v_effective_pd_id
      from public.receipts
     where id = p_corrects_receipt_id and organization_id = p_organization_id;

    if not found then
      raise exception 'receipt % not found', p_corrects_receipt_id
        using errcode = 'GA012';
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
  end if;

  select source_document_id into v_source_document_id
    from public.purchase_documents
   where id = v_effective_pd_id;

  v_verifier := public.current_document_delivery_verifier_employee_id(v_source_document_id, p_organization_id);

  v_receipt_id := gen_random_uuid();

  begin
    insert into public.receipts (
      id, organization_id, purchase_document_id, receipt_kind, corrects_receipt_id,
      default_location_id, delivery_verified_by_employee_id_snapshot, recorded_by_app_user_id, notes, idempotency_key
    ) values (
      v_receipt_id, p_organization_id, v_effective_pd_id, p_receipt_kind, p_corrects_receipt_id,
      p_default_location_id, v_verifier, p_app_user_id, p_notes, p_idempotency_key
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

revoke all on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, text) from public;
grant execute on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, text) to service_role;
