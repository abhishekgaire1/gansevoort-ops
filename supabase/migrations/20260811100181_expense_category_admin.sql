-- Expense-category administration: descriptions, admin usage counts, a
-- catch-all "requires explanation" flag, and per-line classification
-- explanations. User-facing "Spend Category" becomes "Expense Category";
-- the technical table name public.spend_categories is intentionally kept
-- (renaming it would create needless migration risk), so these all target
-- spend_categories / spend_category_id under the hood.
--
-- Conventions mirror the admin master-data RPCs: SECURITY DEFINER,
-- set search_path = '', fully schema-qualified, p_actor for audit only
-- (role checks live in the server-action layer), audit_events on every
-- change, GA0xx error codes, revoke/grant to service_role.

-- 1. Descriptions on both category tables (nullable) + the catch-all flag.
alter table public.spend_categories add column description text;
alter table public.spend_categories add column requires_explanation boolean not null default false;
alter table public.inventory_categories add column description text;

-- 2. Per-line classification explanation (the written reason a line was
--    classed to a catch-all expense category). Nullable; line
--    classifications are mutable (status PENDING_REVIEW -> CONFIRMED), so a
--    plain column + UPDATE is safe -- no append-only trigger here.
alter table public.purchase_document_line_classifications add column explanation text;

-- 3. Update an expense category's description.
create or replace function public.update_spend_category_description(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_category_id uuid,
  p_description text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.spend_categories where id = p_category_id and organization_id = p_organization_id) then
    raise exception 'expense category % not found in organization %', p_category_id, p_organization_id using errcode = 'GA034';
  end if;
  update public.spend_categories
     set description = nullif(btrim(coalesce(p_description, '')), '')
   where id = p_category_id and organization_id = p_organization_id;
  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'SPEND_CATEGORY_DESCRIPTION_UPDATED', 'spend_category', p_category_id,
          jsonb_build_object('description', nullif(btrim(coalesce(p_description, '')), '')));
end;
$$;

revoke all on function public.update_spend_category_description(uuid, uuid, uuid, text) from public;
grant execute on function public.update_spend_category_description(uuid, uuid, uuid, text) to service_role;

-- 4. Update an inventory category's description.
create or replace function public.update_inventory_category_description(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_category_id uuid,
  p_description text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.inventory_categories where id = p_category_id and organization_id = p_organization_id) then
    raise exception 'inventory category % not found in organization %', p_category_id, p_organization_id using errcode = 'GA034';
  end if;
  update public.inventory_categories
     set description = nullif(btrim(coalesce(p_description, '')), '')
   where id = p_category_id and organization_id = p_organization_id;
  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'INVENTORY_CATEGORY_DESCRIPTION_UPDATED', 'inventory_category', p_category_id,
          jsonb_build_object('description', nullif(btrim(coalesce(p_description, '')), '')));
end;
$$;

revoke all on function public.update_inventory_category_description(uuid, uuid, uuid, text) from public;
grant execute on function public.update_inventory_category_description(uuid, uuid, uuid, text) to service_role;

-- 5. Admin usage counts for expense categories -- how many CONFIRMED
--    non-inventory classifications reference each one (the analogue of
--    get_inventory_category_item_counts for inventory). Unscoped by date.
create or replace function public.get_spend_category_usage_counts(
  p_organization_id uuid
)
returns table (
  out_category_id uuid,
  out_usage_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select spend_category_id, count(*)
    from public.inventory_items
   where organization_id = p_organization_id
     and disposition = 'NON_INVENTORY'
     and approval_status = 'CONFIRMED'
     and spend_category_id is not null
   group by spend_category_id;
$$;

revoke all on function public.get_spend_category_usage_counts(uuid) from public;
grant execute on function public.get_spend_category_usage_counts(uuid) to service_role;

-- 6. Record the written explanation for a line classified to a catch-all
--    expense category (e.g. "Other Non-inventory Expense"). Rejects a blank
--    explanation with GA086 so the catch-all can never be used silently.
create or replace function public.set_line_classification_explanation(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_explanation text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_explanation text := nullif(btrim(coalesce(p_explanation, '')), '');
begin
  if v_explanation is null then
    raise exception 'a written explanation is required for this expense category' using errcode = 'GA086';
  end if;
  if not exists (
    select 1 from public.purchase_document_line_classifications
     where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id and line_key = p_line_key
  ) then
    raise exception 'line classification not found in organization %', p_organization_id using errcode = 'GA034';
  end if;
  update public.purchase_document_line_classifications
     set explanation = v_explanation
   where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id and line_key = p_line_key;
  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'LINE_CLASSIFICATION_EXPLANATION_SET', 'purchase_document_line', p_purchase_document_id,
          jsonb_build_object('lineKey', p_line_key, 'explanation', v_explanation));
end;
$$;

revoke all on function public.set_line_classification_explanation(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.set_line_classification_explanation(uuid, uuid, uuid, uuid, text) to service_role;
