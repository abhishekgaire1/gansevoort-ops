-- Hotfix for two confirmed implementation defects in migration 20260811100029,
-- found during the first real integration run against linked DEV. Migration
-- 100029 itself is NOT edited (already applied) -- this is a narrow
-- CREATE OR REPLACE of the two affected functions only. No schema, trigger,
-- constraint, notification, audit, UI, or queue changes.
--
-- Defect 1 (blocking): purchase_document_diff's line-correlation subqueries
-- alias a single-column subquery as `line`:
--
--   from (select jsonb_array_elements(...) as value) as line
--
-- and then incorrectly wrote `line -> 'value'`, which applies the `->`
-- jsonb operator to the whole-row RECORD produced by that subquery alias
-- (which has no such operator), rather than to its `value` column. This
-- raised SQLSTATE 42883 ("operator does not exist: record -> unknown")
-- whenever either side of a diff had at least one line -- i.e. essentially
-- every real invoice/receipt -- breaking verify_purchase_document and
-- save_purchase_document_review_corrections for any document with lines.
-- Confirmed via direct reproduction against TEST RPC Fixture Org. Fixed by
-- referencing the subquery's own `value` column (`line.value`) instead of
-- treating the row alias itself as jsonb. The diff algorithm, its output
-- shape, and the correction-count semantics are otherwise unchanged.
--
-- Defect 2 (minor): save_purchase_document_review_corrections' "no
-- submission to correct against" raise had no application SQLSTATE, so it
-- fell through mapPurchaseDocumentRpcError's default branch as an
-- unclassified generic error instead of the same GA002
-- ("STALE_OR_WRONG_STATUS") code already used by this function's own
-- version/status UPDATE-not-found check just below it -- both are the same
-- class of failure ("this document is not in a correctable state right
-- now"), so they now share the same code. The human-readable message is
-- unchanged.

create or replace function public.purchase_document_diff(
  p_old_header jsonb,
  p_old_lines jsonb,
  p_new_header jsonb,
  p_new_lines jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_header_changes jsonb := '[]'::jsonb;
  v_line_changes jsonb := '[]'::jsonb;
  v_field text;
  v_old_lines_by_key jsonb;
  v_new_lines_by_key jsonb;
  v_key text;
  v_old_line jsonb;
  v_new_line jsonb;
  v_line_field_changes jsonb;
  v_line_field text;
begin
  foreach v_field in array array[
    'vendor_id', 'document_type', 'document_number', 'document_date',
    'po_number', 'delivery_date', 'subtotal', 'tax', 'fees', 'total', 'currency'
  ]
  loop
    if (p_old_header -> v_field) is distinct from (p_new_header -> v_field) then
      v_header_changes := v_header_changes
        || jsonb_build_array(jsonb_build_object('field', v_field, 'before', p_old_header -> v_field, 'after', p_new_header -> v_field));
    end if;
  end loop;

  select coalesce(jsonb_object_agg(line.value ->> 'line_key', line.value), '{}'::jsonb) into v_old_lines_by_key
    from (select jsonb_array_elements(coalesce(p_old_lines, '[]'::jsonb)) as value) as line
   where line.value ->> 'line_key' is not null;

  select coalesce(jsonb_object_agg(line.value ->> 'line_key', line.value), '{}'::jsonb) into v_new_lines_by_key
    from (select jsonb_array_elements(coalesce(p_new_lines, '[]'::jsonb)) as value) as line
   where line.value ->> 'line_key' is not null;

  for v_key, v_old_line in select key, value from jsonb_each(v_old_lines_by_key)
  loop
    if not (v_new_lines_by_key ? v_key) then
      v_line_changes := v_line_changes || jsonb_build_array(jsonb_build_object('lineKey', v_key, 'kind', 'removed', 'line', v_old_line));
    end if;
  end loop;

  for v_key, v_new_line in select key, value from jsonb_each(v_new_lines_by_key)
  loop
    if not (v_old_lines_by_key ? v_key) then
      v_line_changes := v_line_changes || jsonb_build_array(jsonb_build_object('lineKey', v_key, 'kind', 'added', 'line', v_new_line));
    else
      v_old_line := v_old_lines_by_key -> v_key;
      v_line_field_changes := '[]'::jsonb;
      foreach v_line_field in array array[
        'vendor_sku', 'description', 'package_quantity', 'package_unit',
        'measured_quantity', 'measured_unit', 'unit_price', 'price_basis_unit', 'line_total'
      ]
      loop
        if (v_old_line -> v_line_field) is distinct from (v_new_line -> v_line_field) then
          v_line_field_changes := v_line_field_changes
            || jsonb_build_array(jsonb_build_object('field', v_line_field, 'before', v_old_line -> v_line_field, 'after', v_new_line -> v_line_field));
        end if;
      end loop;
      if jsonb_array_length(v_line_field_changes) > 0 then
        v_line_changes := v_line_changes || jsonb_build_array(jsonb_build_object('lineKey', v_key, 'kind', 'modified', 'fields', v_line_field_changes));
      end if;
    end if;
  end loop;

  return jsonb_build_object('headerChanges', v_header_changes, 'lineChanges', v_line_changes);
end;
$$;

revoke all on function public.purchase_document_diff(jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.purchase_document_diff(jsonb, jsonb, jsonb, jsonb) to service_role;

create or replace function public.save_purchase_document_review_corrections(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_header jsonb,
  p_lines jsonb
)
returns table (
  out_purchase_document_id uuid,
  out_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_submission_event_id uuid;
  v_old_header jsonb;
  v_old_lines jsonb;
  v_new_version integer;
  v_new_header jsonb;
  v_new_lines jsonb;
  v_diff jsonb;
begin
  select created_by_app_user_id into v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by = p_app_user_id then
    raise exception 'app_user % prepared purchase_document % and cannot review-correct it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  select jsonb_build_object(
      'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
      'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
      'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
    )
    into v_old_header
    from public.purchase_documents
   where id = p_purchase_document_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
      'package_quantity', package_quantity, 'package_unit', package_unit,
      'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
      'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
    ) order by line_number), '[]'::jsonb)
    into v_old_lines
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id;

  select id into v_submission_event_id
    from public.audit_events
   where entity_type = 'purchase_document'
     and entity_id = p_purchase_document_id
     and action = 'PURCHASE_DOCUMENT_SUBMITTED'
   order by occurred_at desc
   limit 1;

  if v_submission_event_id is null then
    raise exception 'purchase_document % has no submission to correct against', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  -- Only now, after every check above has already succeeded, enable the
  -- narrow trigger-level capability the freeze triggers require.
  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

  update public.purchase_documents as pd
     set vendor_id = (p_header->>'vendorId')::uuid,
         document_type = p_header->>'documentType',
         document_number = p_header->>'documentNumber',
         document_date = public.safe_parse_date(p_header->>'documentDate'),
         po_number = p_header->>'poNumber',
         delivery_date = public.safe_parse_date(p_header->>'deliveryDate'),
         subtotal = (p_header->>'subtotal')::numeric,
         tax = (p_header->>'tax')::numeric,
         fees = (p_header->>'fees')::numeric,
         total = (p_header->>'total')::numeric,
         currency = p_header->>'currency',
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'READY_FOR_VERIFICATION'
     and pd.version = p_expected_version
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be corrected: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value)
    where line.value ->> 'lineKey' is not null
    group by line.value ->> 'lineKey'
    having count(*) > 1
  ) then
    raise exception 'duplicate line_key values in submitted lines for purchase_document %', p_purchase_document_id;
  end if;

  delete from public.purchase_document_lines as pdl
   where pdl.purchase_document_id = p_purchase_document_id;

  insert into public.purchase_document_lines as pdl (
    id, organization_id, purchase_document_id, line_number, line_key,
    vendor_sku, description, package_quantity, package_unit,
    measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
  )
  select
    gen_random_uuid(), p_organization_id, p_purchase_document_id, ord.idx,
    coalesce((ord.line_json->>'lineKey')::uuid, gen_random_uuid()),
    ord.line_json->>'vendorSku', ord.line_json->>'description',
    (ord.line_json->>'packageQuantity')::numeric, ord.line_json->>'packageUnit',
    (ord.line_json->>'measuredQuantity')::numeric, ord.line_json->>'measuredUnit',
    (ord.line_json->>'unitPrice')::numeric, ord.line_json->>'priceBasisUnit',
    (ord.line_json->>'lineTotal')::numeric
  from (
    select value as line_json, row_number() over () as idx
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  ) as ord;

  select jsonb_build_object(
      'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
      'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
      'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
    )
    into v_new_header
    from public.purchase_documents
   where id = p_purchase_document_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
      'package_quantity', package_quantity, 'package_unit', package_unit,
      'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
      'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
    ) order by line_number), '[]'::jsonb)
    into v_new_lines
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id;

  v_diff := public.purchase_document_diff(v_old_header, v_old_lines, v_new_header, v_new_lines);

  if public.purchase_document_diff_count(v_diff) > 0 then
    insert into public.audit_events (
      organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
    ) values (
      p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_REVIEW_CORRECTED', 'purchase_document', p_purchase_document_id,
      v_diff || jsonb_build_object('submissionAuditEventId', v_submission_event_id)
    );
  end if;

  return query select p_purchase_document_id, v_new_version;
end;
$$;

revoke all on function public.save_purchase_document_review_corrections(uuid, uuid, uuid, integer, jsonb, jsonb) from public;
grant execute on function public.save_purchase_document_review_corrections(uuid, uuid, uuid, integer, jsonb, jsonb) to service_role;
