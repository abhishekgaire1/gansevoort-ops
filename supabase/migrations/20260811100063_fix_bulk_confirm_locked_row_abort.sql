-- Fixes a real bug in 20260811100060, caught by a second-pass adversarial
-- review of this fix pass itself.
--
-- 20260811100060 added a preparer-ownership filter to
-- bulk_confirm_line_classifications's FOR loop:
--   and (pd.status <> 'DRAFT' or pd.created_by_app_user_id = p_app_user_id)
-- The intent was "skip a row that isn't this caller's own DRAFT," but the
-- OR means a row whose document is READY_FOR_VERIFICATION/VERIFIED is
-- INCLUDED in the loop regardless of who's calling -- this function never
-- sets gansevoort.purchase_document_ready_write, so the UPDATE against
-- such a row unconditionally hits purchase_document_line_classifications
-- _forbid_when_locked (20260811100056) and raises an unhandled exception.
-- With no EXCEPTION block around the loop, that aborts and rolls back the
-- ENTIRE function call -- including every classification already
-- confirmed earlier in the same loop iteration, for a different, fully
-- eligible DRAFT document in the same batch. This defect predates
-- 20260811100060 (present since 20260811100056 shipped the lock trigger,
-- since bulk_confirm_line_classifications never filtered by document
-- status at all before), but 20260811100060's own comment and
-- bulkConfirmLineClassificationsRpc.ts's doc comment both claim the
-- "skip the ineligible row, keep processing the rest" property that this
-- specific case does not actually have -- worth fixing now rather than
-- shipping an inaccurate claim about it.
--
-- Fix: a classification row is only ever eligible for this function's
-- bulk write path when its document is BOTH a DRAFT AND owned by the
-- calling preparer -- never OR. Every other case (wrong preparer OR
-- locked status) is now excluded from the loop entirely, so the UPDATE
-- is never even attempted against a row this function can't legitimately
-- write to. This matches reality: bulk_confirm_line_classifications has
-- no trusted-write flag and therefore can never successfully write to a
-- non-DRAFT document regardless of this filter -- the filter now reflects
-- that truthfully instead of relying on the lock trigger to fail loudly.
create or replace function public.bulk_confirm_line_classifications(
  p_classification_ids uuid[],
  p_organization_id uuid,
  p_app_user_id uuid
)
returns table (
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select c.id, c.purchase_document_id, c.line_key, c.ai_suggested_inventory_item_id
      from public.purchase_document_line_classifications c
      join public.purchase_documents pd
        on pd.id = c.purchase_document_id and pd.organization_id = c.organization_id
     where c.id = any(p_classification_ids)
       and c.organization_id = p_organization_id
       and c.status = 'PENDING_REVIEW'
       and c.resolution_source = 'AI_SUGGESTED'
       and c.ai_suggested_inventory_item_id is not null
       and pd.status = 'DRAFT'
       and pd.created_by_app_user_id = p_app_user_id
  loop
    update public.purchase_document_line_classifications
       set inventory_item_id = v_row.ai_suggested_inventory_item_id,
           status = 'CONFIRMED',
           resolution_source = 'MANUAL',
           resolved_by_app_user_id = p_app_user_id,
           resolved_at = now()
     where id = v_row.id;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', v_row.purchase_document_id,
      jsonb_build_object('lineKey', v_row.line_key, 'inventoryItemId', v_row.ai_suggested_inventory_item_id, 'newItem', false, 'bulk', true));

    out_classification_id := v_row.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.bulk_confirm_line_classifications(uuid[], uuid, uuid) from public;
grant execute on function public.bulk_confirm_line_classifications(uuid[], uuid, uuid) to service_role;
