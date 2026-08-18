-- Milestone 2A.4 (part 2 of 2): the guarded DEV-only operational reset.
--
-- WHY THIS IS A FUNCTION AT ALL: most operational tables are protected by
-- append-only forbid_update_delete triggers (movements, receipts,
-- documents, ...) and status-lock triggers (purchase_documents/lines,
-- classifications, ...) that fire for EVERY role including service_role --
-- by design. A plain script using the service-role API therefore cannot
-- delete them, and that protection must stay fully intact for normal
-- operation. The only clean escape hatch is a SECURITY DEFINER function
-- (owned by postgres, the table owner) that temporarily runs
-- ALTER TABLE ... DISABLE TRIGGER USER inside one transaction, deletes in
-- FK order, and re-enables the triggers before committing. FK constraint
-- (system) triggers are NOT disabled by DISABLE TRIGGER USER, so
-- referential integrity stays enforced throughout.
--
-- WHY IT IS STILL SAFE TO EXIST IN THE SCHEMA:
-- 1. service_role-only, and the app never calls it -- it is invoked
--    exclusively by scripts/reset-gansevoort-dev-operational-data.ts,
--    which has its own project-ref verification + explicit flags.
-- 2. DEV fingerprint: it REFUSES to run unless the database also contains
--    the integration-test fixture organization ("TEST RPC Fixture Org",
--    created only by scripts/test-integration-setup.ts in the linked DEV
--    project). A production database will never contain that org, so this
--    function is inert there even if called.
-- 3. Target allow-list: the target organization's name must be exactly
--    'Gansevoort' (the real DEV org) or start with 'TEST Reset Sandbox'
--    (disposable orgs created by the reset's own integration test). The
--    TEST RPC Fixture orgs and anything else are categorically refused.
-- 4. Explicit confirmation: p_confirmation must be the exact phrase
--    'RESET <ORG NAME> OPERATIONAL DATA'.
--
-- WHAT IT DELETES (org-scoped, operational/transactional ONLY):
-- exceptions, inventory posting lines/postings, stock references,
-- inventory movement lines/movements, user notifications, invoice-unit
-- confirmations, line classifications, classification runs, receipt
-- lines/receipts, purchase document lines/documents (all revisions),
-- delivery-verifier corrections, document archives, document extractions,
-- documents, PIN rate-limit counters, and orphaned AI-proposed
-- PENDING_REVIEW inventory items (never CONFIRMED ones, and never any
-- referenced by a vendor_item_mapping).
--
-- WHAT IT NEVER TOUCHES: organizations, locations, stations, employees,
-- app_users, roles/user_roles, units, inventory_categories, CONFIRMED
-- inventory_items, inventory_item_units, spend_categories, vendors,
-- vendor_item_mappings (confirmed learning preserved), control_rules --
-- and audit_events, which are immutable history by project rule and are
-- deliberately retained even for deleted entities (they carry no FKs to
-- the deleted rows).
create or replace function public.reset_dev_organization_operational_data(
  p_organization_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_name text;
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
begin
  -- DEV fingerprint -- refuse anywhere the integration-test fixture org
  -- doesn't exist (i.e., any non-DEV database).
  if not exists (select 1 from public.organizations where name = 'TEST RPC Fixture Org') then
    raise exception 'refusing: this does not look like the DEV database (no integration-test fixture organization present)';
  end if;

  select name into v_org_name from public.organizations where id = p_organization_id;
  if v_org_name is null then
    raise exception 'organization % not found', p_organization_id;
  end if;

  if v_org_name <> 'Gansevoort' and v_org_name not like 'TEST Reset Sandbox%' then
    raise exception 'refusing to reset organization "%" -- only the Gansevoort DEV organization (or a disposable TEST Reset Sandbox org) may be reset', v_org_name;
  end if;

  if p_confirmation is distinct from ('RESET ' || upper(v_org_name) || ' OPERATIONAL DATA') then
    raise exception 'confirmation phrase mismatch -- expected exactly: RESET % OPERATIONAL DATA', upper(v_org_name);
  end if;

  -- Temporarily lift the append-only/lock triggers on exactly the tables
  -- being cleared. FK integrity (system triggers) remains fully enforced.
  alter table public.inventory_movements disable trigger user;
  alter table public.inventory_movement_lines disable trigger user;
  alter table public.receipts disable trigger user;
  alter table public.receipt_lines disable trigger user;
  alter table public.documents disable trigger user;
  alter table public.document_extractions disable trigger user;
  alter table public.document_archives disable trigger user;
  alter table public.document_delivery_verifier_corrections disable trigger user;
  alter table public.purchase_documents disable trigger user;
  alter table public.purchase_document_lines disable trigger user;
  alter table public.purchase_document_line_classifications disable trigger user;
  alter table public.purchase_document_line_invoice_unit_confirmations disable trigger user;
  alter table public.purchase_document_inventory_postings disable trigger user;
  alter table public.purchase_document_inventory_posting_lines disable trigger user;
  alter table public.inventory_stock_references disable trigger user;

  -- Children before parents, FK order throughout.
  delete from public.exceptions where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('exceptions', v_count);

  delete from public.purchase_document_inventory_posting_lines where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('purchase_document_inventory_posting_lines', v_count);

  delete from public.inventory_stock_references where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inventory_stock_references', v_count);

  delete from public.purchase_document_inventory_postings where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('purchase_document_inventory_postings', v_count);

  delete from public.inventory_movement_lines ml
   using public.inventory_movements m
   where ml.movement_id = m.id and m.organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inventory_movement_lines', v_count);

  delete from public.inventory_movements where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inventory_movements', v_count);

  delete from public.user_notifications where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('user_notifications', v_count);

  delete from public.purchase_document_line_invoice_unit_confirmations where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('purchase_document_line_invoice_unit_confirmations', v_count);

  delete from public.purchase_document_line_classifications where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('purchase_document_line_classifications', v_count);

  delete from public.purchase_document_classification_runs where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('purchase_document_classification_runs', v_count);

  delete from public.receipt_lines where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('receipt_lines', v_count);

  delete from public.receipts where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('receipts', v_count);

  delete from public.purchase_document_lines where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('purchase_document_lines', v_count);

  delete from public.purchase_documents where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('purchase_documents', v_count);

  delete from public.document_delivery_verifier_corrections where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('document_delivery_verifier_corrections', v_count);

  delete from public.document_archives where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('document_archives', v_count);

  delete from public.document_extractions where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('document_extractions', v_count);

  delete from public.documents where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('documents', v_count);

  delete from public.pin_verify_rate_limits where organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('pin_verify_rate_limits', v_count);

  -- Orphaned AI proposals only: PENDING_REVIEW, AI_PROPOSED, and not
  -- referenced by any vendor-item mapping. CONFIRMED items are master
  -- data and are never touched. (A PENDING_REVIEW item structurally has
  -- no inventory_item_units rows -- those are created at confirmation --
  -- but delete defensively anyway.)
  delete from public.inventory_item_units iiu
   using public.inventory_items ii
   where iiu.inventory_item_id = ii.id
     and ii.organization_id = p_organization_id
     and ii.approval_status = 'PENDING_REVIEW'
     and ii.created_via = 'AI_PROPOSED'
     and not exists (select 1 from public.vendor_item_mappings vm where vm.inventory_item_id = ii.id);

  delete from public.inventory_items ii
   where ii.organization_id = p_organization_id
     and ii.approval_status = 'PENDING_REVIEW'
     and ii.created_via = 'AI_PROPOSED'
     and not exists (select 1 from public.vendor_item_mappings vm where vm.inventory_item_id = ii.id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('ai_proposed_pending_inventory_items', v_count);

  -- Restore every protection before committing.
  alter table public.inventory_movements enable trigger user;
  alter table public.inventory_movement_lines enable trigger user;
  alter table public.receipts enable trigger user;
  alter table public.receipt_lines enable trigger user;
  alter table public.documents enable trigger user;
  alter table public.document_extractions enable trigger user;
  alter table public.document_archives enable trigger user;
  alter table public.document_delivery_verifier_corrections enable trigger user;
  alter table public.purchase_documents enable trigger user;
  alter table public.purchase_document_lines enable trigger user;
  alter table public.purchase_document_line_classifications enable trigger user;
  alter table public.purchase_document_line_invoice_unit_confirmations enable trigger user;
  alter table public.purchase_document_inventory_postings enable trigger user;
  alter table public.purchase_document_inventory_posting_lines enable trigger user;
  alter table public.inventory_stock_references enable trigger user;

  insert into public.audit_events (organization_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, 'DEV_OPERATIONAL_DATA_RESET', 'organization', p_organization_id, v_counts);

  return v_counts;
end;
$$;

revoke all on function public.reset_dev_organization_operational_data(uuid, text) from public;
grant execute on function public.reset_dev_organization_operational_data(uuid, text) to service_role;
