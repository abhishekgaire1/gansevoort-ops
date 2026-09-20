-- Transactional manager RPC to resolve an ambiguous delivery lineage.
-- Append-only (writes one delivery_resolutions row + one audit event); never
-- posts inventory, alters balances/movements, deletes receipts, or touches
-- prices. Already-posted conflicts are NOT resolved here -- routed to Inventory
-- Correction. Manager/Admin only. Rejects stale/incomplete/foreign/duplicate
-- submissions.

create or replace function public.resolve_delivery_lineage(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_fingerprint text,
  p_reason text,
  p_acknowledged boolean,
  p_decisions jsonb
)
returns table (
  out_resolution_id uuid,
  out_resolution_version integer,
  out_status text,
  out_routed_to_correction boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprint text;
  v_is_manager boolean;
  v_effective_ids uuid[];
  v_decision_ids uuid[];
  v_canonical_count integer;
  v_already_posted boolean;
  v_version integer;
  v_resolution_id uuid;
  v_before jsonb;
  v_after jsonb;
  d jsonb;
begin
  if not coalesce(p_acknowledged, false) then
    raise exception 'delivery-lineage resolution requires explicit acknowledgment' using errcode = 'GA033';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to resolve delivery lineage' using errcode = 'GA033';
  end if;

  -- Manager/Admin authorization (defense in depth; the action also checks).
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
     where ur.app_user_id = p_app_user_id and ur.organization_id = p_organization_id
       and lower(r.name) in ('manager', 'admin')
  ) into v_is_manager;
  if not v_is_manager then
    raise exception 'app_user % is not authorized to resolve delivery lineage', p_app_user_id using errcode = 'GA006';
  end if;

  -- Lock the document and its receipts/lines (deterministic order) so lineage
  -- cannot change between validation and save (held until commit/rollback).
  perform 1 from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id for no key update;
  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id using errcode = 'GA054';
  end if;
  perform 1 from public.receipts
   where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id
   order by id for no key update;

  -- Stale check: the submitted resolution must match the CURRENT lineage.
  v_fingerprint := public.purchase_document_delivery_fingerprint(p_purchase_document_id, p_organization_id);
  if v_fingerprint is distinct from p_expected_fingerprint then
    raise exception 'the recorded deliveries changed since this was reviewed; reload and try again' using errcode = 'GA002';
  end if;

  -- Current effective delivery receipts (before resolution): the full set the
  -- decisions must account for exactly once.
  select array_agg(er.id order by er.id) into v_effective_ids
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
   where exists (
     select 1 from public.receipt_lines rl
      where rl.receipt_id = er.id and rl.organization_id = p_organization_id and rl.matched_line_key is not null
   );

  if coalesce(array_length(v_effective_ids, 1), 0) < 2 then
    raise exception 'this document has no ambiguous delivery lineage to resolve' using errcode = 'GA033';
  end if;

  -- Validate decisions: every effective receipt exactly once; every referenced
  -- receipt belongs to this document; DUPLICATE points at a CANONICAL in-set.
  select array_agg((d->>'receiptId')::uuid order by (d->>'receiptId')::uuid)
    into v_decision_ids
    from jsonb_array_elements(p_decisions) d;

  if v_decision_ids is distinct from v_effective_ids then
    raise exception 'the resolution must account for every current recorded delivery exactly once' using errcode = 'GA033';
  end if;

  v_canonical_count := 0;
  for d in select * from jsonb_array_elements(p_decisions) loop
    if d->>'decision' not in ('CANONICAL', 'DUPLICATE') then
      raise exception 'invalid delivery-resolution decision %', d->>'decision' using errcode = 'GA033';
    end if;
    if d->>'decision' = 'CANONICAL' then
      v_canonical_count := v_canonical_count + 1;
    else
      -- DUPLICATE must reference a CANONICAL receipt present in this resolution.
      if not exists (
        select 1 from jsonb_array_elements(p_decisions) c
         where c->>'decision' = 'CANONICAL' and (c->>'receiptId')::uuid = (d->>'duplicateOfReceiptId')::uuid
      ) then
        raise exception 'a duplicate delivery must reference a retained (canonical) delivery' using errcode = 'GA033';
      end if;
    end if;
  end loop;

  if v_canonical_count < 1 then
    raise exception 'at least one recorded delivery must be retained' using errcode = 'GA033';
  end if;

  -- Already-posted conflict: any effective receipt already contributed to
  -- inventory -> do NOT resolve by exclusion; route to Inventory Correction.
  select exists (
    select 1 from public.purchase_document_inventory_posting_lines pl
     where pl.organization_id = p_organization_id
       and pl.receipt_line_id in (
         select rl.id from public.receipt_lines rl where rl.receipt_id = any(v_effective_ids)
       )
  ) into v_already_posted;
  if v_already_posted then
    out_resolution_id := null; out_resolution_version := null;
    out_status := 'ALREADY_POSTED'; out_routed_to_correction := true;
    return next; return;
  end if;

  -- Before/after quantity snapshots (received package quantity per matched line).
  select jsonb_agg(x) into v_before from (
    select rl.matched_line_key as line_key, sum(rl.actual_received_package_quantity) as qty, max(rl.actual_received_package_unit) as unit
      from public.receipt_lines rl
     where rl.receipt_id = any(v_effective_ids) and rl.matched_line_key is not null
     group by rl.matched_line_key
  ) x;
  select jsonb_agg(x) into v_after from (
    select rl.matched_line_key as line_key, sum(rl.actual_received_package_quantity) as qty, max(rl.actual_received_package_unit) as unit
      from public.receipt_lines rl
     where rl.matched_line_key is not null
       and rl.receipt_id in (
         select (c->>'receiptId')::uuid from jsonb_array_elements(p_decisions) c where c->>'decision' = 'CANONICAL'
       )
     group by rl.matched_line_key
  ) x;

  select coalesce(max(resolution_version), 0) + 1 into v_version
    from public.delivery_resolutions
   where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id;

  insert into public.delivery_resolutions (
    organization_id, purchase_document_id, resolution_version, fingerprint,
    resolved_by_app_user_id, reason, decisions, before_quantity, after_quantity
  ) values (
    p_organization_id, p_purchase_document_id, v_version, v_fingerprint,
    p_app_user_id, p_reason, p_decisions, v_before, v_after
  ) returning id into v_resolution_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'DELIVERY_LINEAGE_RESOLVED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('resolutionId', v_resolution_id, 'version', v_version, 'canonicalCount', v_canonical_count,
                       'decisions', p_decisions, 'before', v_before, 'after', v_after));

  out_resolution_id := v_resolution_id;
  out_resolution_version := v_version;
  out_status := public.purchase_document_delivery_status(p_purchase_document_id, p_organization_id);
  out_routed_to_correction := false;
  return next;
end;
$$;

revoke all on function public.resolve_delivery_lineage(uuid, uuid, uuid, text, text, boolean, jsonb) from public;
grant execute on function public.resolve_delivery_lineage(uuid, uuid, uuid, text, text, boolean, jsonb) to service_role;
