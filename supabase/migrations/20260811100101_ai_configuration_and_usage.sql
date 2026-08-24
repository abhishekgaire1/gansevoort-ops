-- AI Configuration + Usage/Cost Tracking milestone.
--
-- ============================================================
-- WHAT ALREADY EXISTED (verified by direct inspection before writing this
-- migration) -- this migration deliberately does NOT rebuild any of it:
-- ============================================================
-- app/lib/ai/provider.ts already defines a generic AIProvider interface
-- (generateStructuredOutput) and app/lib/ai/providers/gemini.ts already
-- implements it, including rich usage-metadata extraction
-- (extractGeminiDebugMetadata/sanitizeGeminiRawResponse -- prompt/
-- candidates/cached/thoughts token counts). document_extractions
-- (20260811100038) already has NOT NULL provider/model columns and
-- immutable-once-terminal provenance for invoice extraction specifically.
-- None of that is touched here. What genuinely does not exist yet:
--   1. Any per-organization AI configuration (provider/model is currently
--      resolved from a single env var, GEMINI_MODEL, with no per-task or
--      per-org override at all).
--   2. A durable, cross-task usage/cost ledger -- item classification
--      (app/lib/ai/tasks/itemClassification) currently produces ZERO
--      durable usage record of any kind; invoice extraction's usage
--      metadata is captured but only inside a jsonb blob
--      (document_extractions.provider_metadata), never normalized into a
--      queryable/aggregable shape.
--   3. Any pricing/cost calculation anywhere in this codebase.

-- ============================================================
-- 1. organization_ai_settings -- the organization-wide default
--    provider/model (Part 9/11/12). One row per org; absence means "use
--    the safe application fallback default" (app/lib/ai/config.ts).
-- ============================================================
create table public.organization_ai_settings (
  organization_id uuid primary key references public.organizations (id),
  default_provider text not null,
  default_model text not null,
  updated_by_app_user_id uuid not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint organization_ai_settings_updated_by_org_fk foreign key (updated_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

alter table public.organization_ai_settings enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 2. organization_ai_task_settings -- per-task override (Part 9-11). A
--    task with no row here uses the organization default above; a task
--    key is NEVER user-invented (task_key is CHECK-constrained to the
--    exact set app/lib/ai/taskKeys.ts defines as configurable). "Use
--    Default" is represented by the absence of a row, not a nullable
--    provider/model pair -- one clean state instead of two ways to mean
--    the same thing.
-- ============================================================
create table public.organization_ai_task_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  task_key text not null,
  provider text not null,
  model text not null,
  updated_by_app_user_id uuid not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint organization_ai_task_settings_task_key_check
    check (task_key in ('INVOICE_EXTRACTION', 'ITEM_CLASSIFICATION')),
  constraint organization_ai_task_settings_updated_by_org_fk foreign key (updated_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create unique index organization_ai_task_settings_org_task_key
  on public.organization_ai_task_settings (organization_id, task_key);

alter table public.organization_ai_task_settings enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 3. ai_model_pricing -- versioned, platform-level (never organization-
--    scoped -- this is application/platform configuration, Part 25, not
--    something an org Admin edits). Fully append-only/insert-only, same
--    integrity category as audit_events: a price change is a NEW row with
--    a later effective_from, never an edit of a prior row's rate. There
--    is deliberately no effective_to column -- "effective_to" for display
--    purposes is derived as the next chronological row's effective_from
--    (or null if this is the latest), which avoids ever needing to UPDATE
--    a previous row when a new price takes effect (Part 24/62/29:
--    historical cost must be computed from whatever row was effective at
--    call time, and that requires the OLD row to never be touched).
--    Currently EMPTY BY DESIGN: the two allowlisted model identifiers
--    (app/lib/ai/models.ts) have no verifiable real-world public pricing
--    this migration can responsibly cite (see final report). Usage/cost
--    reporting is fully functional with an empty catalog -- it correctly
--    shows "Cost unavailable" rather than fabricating a number (Part 28).
--    A developer inserts real effective-dated rows here once verified.
-- ============================================================
create table public.ai_model_pricing (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model text not null,
  effective_from timestamptz not null,
  input_cost_per_million numeric(14, 6) not null,
  output_cost_per_million numeric(14, 6) not null,
  cached_input_cost_per_million numeric(14, 6),
  currency text not null default 'USD',
  -- Developer-maintained provenance for the rate itself (Part 29): where
  -- this number came from, never scraped/automated.
  source_note text,
  created_at timestamptz not null default now(),
  constraint ai_model_pricing_currency_check check (currency = 'USD'),
  constraint ai_model_pricing_rates_check check (input_cost_per_million >= 0 and output_cost_per_million >= 0)
);

create index ai_model_pricing_provider_model_effective_idx
  on public.ai_model_pricing (provider, model, effective_from desc);

create trigger ai_model_pricing_forbid_update
  before update on public.ai_model_pricing
  for each row execute function public.forbid_update_delete();
create trigger ai_model_pricing_forbid_delete
  before delete on public.ai_model_pricing
  for each row execute function public.forbid_update_delete();

alter table public.ai_model_pricing enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 4. ai_usage_events -- the durable, cross-task usage/cost ledger (Part
--    21). Append-only/immutable once written (same integrity category as
--    audit_events) -- no retroactive cost recalculation ever rewrites a
--    row; if pricing is added later for a previously-unpriced model, that
--    is a deliberately-unbuilt future backfill feature (Part 61), not
--    something this table's mutability would need to support.
--
--    request_key is the idempotency key (Part 60): the caller supplies a
--    value that is stable for one real provider attempt (a
--    document_extractions.id, an item-classification run's claim id, or a
--    freshly-generated id for one Test Configuration click) -- the unique
--    index below makes a duplicate application-level retry of the SAME
--    attempt a no-op insert, never a duplicate cost row. A genuinely NEW
--    attempt (e.g. attempt 2 after attempt 1's provider timeout) uses its
--    own distinct request_key, so it is correctly recorded as separate
--    spend (Part 52), not deduplicated away.
--
--    Nullable token/cost columns are nullable because "unavailable" and
--    "zero" are different facts (Part 22/28/72) -- a null
--    estimated_cost_usd means "we cannot state a cost", never "$0".
-- ============================================================
create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  task_key text not null,
  provider text not null,
  model text not null,
  status text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  duration_ms integer not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  cached_input_tokens integer,
  thoughts_tokens integer,
  pricing_id uuid references public.ai_model_pricing (id),
  estimated_cost_usd numeric(14, 6),
  error_code text,
  source_type text,
  source_id uuid,
  actor_app_user_id uuid,
  request_key text not null,
  created_at timestamptz not null default now(),
  constraint ai_usage_events_task_key_check
    check (task_key in ('INVOICE_EXTRACTION', 'ITEM_CLASSIFICATION', 'CHAT', 'CONFIGURATION_TEST')),
  constraint ai_usage_events_status_check check (status in ('SUCCESS', 'FAILED')),
  constraint ai_usage_events_duration_check check (duration_ms >= 0),
  constraint ai_usage_events_cost_check check (estimated_cost_usd is null or estimated_cost_usd >= 0)
);

-- Idempotency: one usage row per (organization, request_key) -- see the
-- table comment above.
create unique index ai_usage_events_org_request_key
  on public.ai_usage_events (organization_id, request_key);

-- Recent-requests drill-down (Part 41).
create index ai_usage_events_org_created_at_idx
  on public.ai_usage_events (organization_id, created_at desc);
-- Cost-by-task aggregation (Part 36/44).
create index ai_usage_events_org_task_created_at_idx
  on public.ai_usage_events (organization_id, task_key, created_at);
-- Cost-by-model/provider aggregation (Part 37/38/44).
create index ai_usage_events_org_provider_model_created_at_idx
  on public.ai_usage_events (organization_id, provider, model, created_at);

create trigger ai_usage_events_forbid_update
  before update on public.ai_usage_events
  for each row execute function public.forbid_update_delete();
create trigger ai_usage_events_forbid_delete
  before delete on public.ai_usage_events
  for each row execute function public.forbid_update_delete();

alter table public.ai_usage_events enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 5. App-defined SQLSTATEs, continuing the project-wide GA0xx sequence
--    (highest in use before this migration: GA057).
-- ============================================================
-- GA058 AI_TASK_KEY_INVALID (defense-in-depth only -- the TypeScript
-- action layer already rejects an unconfigurable task key via
-- isAITaskKey()/CONFIGURABLE_AI_TASK_KEYS before ever reaching this RPC).

-- ============================================================
-- 6. set_ai_default_configuration / set_ai_task_configuration (Part
--    11/18/48). Model-allowlist and task/model-compatibility validation
--    (Part 7/47) happen in the TypeScript action layer BEFORE either RPC
--    is called -- app/lib/ai/models.ts is a code constant, not a table
--    these RPCs can join against, exactly like create_admin_item already
--    trusts its caller's category/unit ids after the action layer
--    resolves them. Both RPCs are reached only from an Admin-gated Server
--    Action (requireAdmin()), and organization_id is always the
--    authenticated Admin's own org, never client-supplied.
-- ============================================================
create or replace function public.set_ai_default_configuration(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_provider text,
  p_model text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before record;
begin
  if btrim(coalesce(p_provider, '')) = '' or btrim(coalesce(p_model, '')) = '' then
    raise exception 'provider and model are required' using errcode = 'GA058';
  end if;

  select default_provider, default_model into v_before
    from public.organization_ai_settings
   where organization_id = p_organization_id;

  insert into public.organization_ai_settings (organization_id, default_provider, default_model, updated_by_app_user_id, updated_at)
  values (p_organization_id, p_provider, p_model, p_actor_app_user_id, now())
  on conflict (organization_id) do update
    set default_provider = excluded.default_provider,
        default_model = excluded.default_model,
        updated_by_app_user_id = excluded.updated_by_app_user_id,
        updated_at = now();

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_actor_app_user_id, 'AI_DEFAULT_CONFIGURATION_CHANGED', 'organization_ai_settings', p_organization_id,
    case when v_before is null then null else jsonb_build_object('provider', v_before.default_provider, 'model', v_before.default_model) end,
    jsonb_build_object('provider', p_provider, 'model', p_model)
  );
end;
$$;

revoke all on function public.set_ai_default_configuration(uuid, uuid, text, text) from public;
grant execute on function public.set_ai_default_configuration(uuid, uuid, text, text) to service_role;

-- p_provider/p_model both NULL means "use default" -- deletes the task
-- override row if one exists (Part 11: one clean state, not a nullable
-- pair sitting alongside a real row).
create or replace function public.set_ai_task_configuration(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_task_key text,
  p_provider text,
  p_model text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before record;
begin
  if p_task_key not in ('INVOICE_EXTRACTION', 'ITEM_CLASSIFICATION') then
    raise exception 'unsupported AI task key %', p_task_key using errcode = 'GA058';
  end if;

  select provider, model into v_before
    from public.organization_ai_task_settings
   where organization_id = p_organization_id and task_key = p_task_key;

  if p_provider is null and p_model is null then
    delete from public.organization_ai_task_settings
     where organization_id = p_organization_id and task_key = p_task_key;

    if v_before is not null then
      insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
      values (
        p_organization_id, p_actor_app_user_id, 'AI_TASK_CONFIGURATION_CHANGED', 'organization_ai_task_settings', p_organization_id,
        jsonb_build_object('taskKey', p_task_key, 'provider', v_before.provider, 'model', v_before.model),
        jsonb_build_object('taskKey', p_task_key, 'provider', null, 'model', null)
      );
    end if;
    return;
  end if;

  if btrim(coalesce(p_provider, '')) = '' or btrim(coalesce(p_model, '')) = '' then
    raise exception 'provider and model are required' using errcode = 'GA058';
  end if;

  insert into public.organization_ai_task_settings (organization_id, task_key, provider, model, updated_by_app_user_id, updated_at)
  values (p_organization_id, p_task_key, p_provider, p_model, p_actor_app_user_id, now())
  on conflict (organization_id, task_key) do update
    set provider = excluded.provider,
        model = excluded.model,
        updated_by_app_user_id = excluded.updated_by_app_user_id,
        updated_at = now();

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_actor_app_user_id, 'AI_TASK_CONFIGURATION_CHANGED', 'organization_ai_task_settings', p_organization_id,
    case when v_before is null then jsonb_build_object('taskKey', p_task_key, 'provider', null, 'model', null)
         else jsonb_build_object('taskKey', p_task_key, 'provider', v_before.provider, 'model', v_before.model) end,
    jsonb_build_object('taskKey', p_task_key, 'provider', p_provider, 'model', p_model)
  );
end;
$$;

revoke all on function public.set_ai_task_configuration(uuid, uuid, text, text, text) from public;
grant execute on function public.set_ai_task_configuration(uuid, uuid, text, text, text) to service_role;

-- ============================================================
-- 7. record_ai_usage_event -- the one write path every AI call passes
--    through (via the TypeScript executeAITask wrapper, Part 20). Looks
--    up the pricing row effective at started_at (the most recent
--    ai_model_pricing row for provider+model with effective_from <=
--    started_at) and computes cost server-side -- never trusts a
--    client/caller-supplied cost. Idempotent on (organization_id,
--    request_key): a duplicate insert for the same attempt is a silent
--    no-op, returning the ORIGINAL row's id so the caller can't tell the
--    difference.
-- ============================================================
create or replace function public.record_ai_usage_event(
  p_organization_id uuid,
  p_task_key text,
  p_provider text,
  p_model text,
  p_status text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_input_tokens integer,
  p_output_tokens integer,
  p_total_tokens integer,
  p_cached_input_tokens integer,
  p_thoughts_tokens integer,
  p_error_code text,
  p_source_type text,
  p_source_id uuid,
  p_actor_app_user_id uuid,
  p_request_key text
)
returns table (out_event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_pricing record;
  v_cost numeric(14, 6);
  v_duration_ms integer;
begin
  select id into v_event_id
    from public.ai_usage_events
   where organization_id = p_organization_id and request_key = p_request_key;

  if found then
    return query select v_event_id;
    return;
  end if;

  v_duration_ms := greatest(0, (extract(epoch from (p_completed_at - p_started_at)) * 1000)::integer);

  select id, input_cost_per_million, output_cost_per_million into v_pricing
    from public.ai_model_pricing
   where provider = p_provider and model = p_model and effective_from <= p_started_at
   order by effective_from desc
   limit 1;

  if v_pricing is not null and p_input_tokens is not null and p_output_tokens is not null then
    v_cost := (p_input_tokens::numeric / 1000000) * v_pricing.input_cost_per_million
            + (p_output_tokens::numeric / 1000000) * v_pricing.output_cost_per_million;
  else
    v_cost := null;
  end if;

  insert into public.ai_usage_events (
    organization_id, task_key, provider, model, status, started_at, completed_at, duration_ms,
    input_tokens, output_tokens, total_tokens, cached_input_tokens, thoughts_tokens,
    pricing_id, estimated_cost_usd, error_code, source_type, source_id, actor_app_user_id, request_key
  ) values (
    p_organization_id, p_task_key, p_provider, p_model, p_status, p_started_at, p_completed_at, v_duration_ms,
    p_input_tokens, p_output_tokens, p_total_tokens, p_cached_input_tokens, p_thoughts_tokens,
    case when v_pricing is not null then v_pricing.id else null end, v_cost,
    p_error_code, p_source_type, p_source_id, p_actor_app_user_id, p_request_key
  )
  on conflict (organization_id, request_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Lost a race against a concurrent duplicate insert for the same
    -- request_key -- re-select the winner's row rather than treating this
    -- as a failure.
    select id into v_event_id from public.ai_usage_events where organization_id = p_organization_id and request_key = p_request_key;
  end if;

  return query select v_event_id;
end;
$$;

revoke all on function public.record_ai_usage_event(uuid, text, text, text, text, timestamptz, timestamptz, integer, integer, integer, integer, integer, text, text, uuid, uuid, text) from public;
grant execute on function public.record_ai_usage_event(uuid, text, text, text, text, timestamptz, timestamptz, integer, integer, integer, integer, integer, text, text, uuid, uuid, text) to service_role;

-- ============================================================
-- 8. Usage & Cost read model -- pure aggregation, org-scoped, never loads
--    raw events to the browser (Part 44/69). Split into focused functions
--    rather than one giant nested-JSON return, matching this schema's
--    existing "returns table" convention. estimated_cost_usd sums are
--    restricted to non-null rows; unknown_cost_request_count carries how
--    many requests in scope have no cost (Part 72) so the UI can render
--    "Cost unavailable for N requests" instead of implying $0.
-- ============================================================
create or replace function public.get_ai_usage_summary(
  p_organization_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns table (
  out_total_cost_usd numeric,
  out_unknown_cost_request_count bigint,
  out_total_requests bigint,
  out_success_requests bigint,
  out_failed_requests bigint,
  out_input_tokens bigint,
  out_output_tokens bigint,
  out_total_tokens bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(estimated_cost_usd), 0)::numeric,
    count(*) filter (where estimated_cost_usd is null),
    count(*),
    count(*) filter (where status = 'SUCCESS'),
    count(*) filter (where status = 'FAILED'),
    coalesce(sum(input_tokens), 0)::bigint,
    coalesce(sum(output_tokens), 0)::bigint,
    coalesce(sum(total_tokens), 0)::bigint
  from public.ai_usage_events
 where organization_id = p_organization_id
   and created_at >= p_period_start
   and created_at < p_period_end;
$$;

revoke all on function public.get_ai_usage_summary(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_ai_usage_summary(uuid, timestamptz, timestamptz) to service_role;

create or replace function public.get_ai_usage_by_task(
  p_organization_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns table (
  out_task_key text,
  out_cost_usd numeric,
  out_unknown_cost_request_count bigint,
  out_request_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select task_key, coalesce(sum(estimated_cost_usd), 0)::numeric, count(*) filter (where estimated_cost_usd is null), count(*)
    from public.ai_usage_events
   where organization_id = p_organization_id
     and created_at >= p_period_start
     and created_at < p_period_end
   group by task_key
   order by coalesce(sum(estimated_cost_usd), 0) desc, count(*) desc;
$$;

revoke all on function public.get_ai_usage_by_task(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_ai_usage_by_task(uuid, timestamptz, timestamptz) to service_role;

create or replace function public.get_ai_usage_by_model(
  p_organization_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns table (
  out_provider text,
  out_model text,
  out_cost_usd numeric,
  out_unknown_cost_request_count bigint,
  out_request_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select provider, model, coalesce(sum(estimated_cost_usd), 0)::numeric, count(*) filter (where estimated_cost_usd is null), count(*)
    from public.ai_usage_events
   where organization_id = p_organization_id
     and created_at >= p_period_start
     and created_at < p_period_end
   group by provider, model
   order by coalesce(sum(estimated_cost_usd), 0) desc, count(*) desc;
$$;

revoke all on function public.get_ai_usage_by_model(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_ai_usage_by_model(uuid, timestamptz, timestamptz) to service_role;

create or replace function public.get_ai_usage_by_provider(
  p_organization_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns table (
  out_provider text,
  out_cost_usd numeric,
  out_unknown_cost_request_count bigint,
  out_request_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select provider, coalesce(sum(estimated_cost_usd), 0)::numeric, count(*) filter (where estimated_cost_usd is null), count(*)
    from public.ai_usage_events
   where organization_id = p_organization_id
     and created_at >= p_period_start
     and created_at < p_period_end
   group by provider
   order by coalesce(sum(estimated_cost_usd), 0) desc, count(*) desc;
$$;

revoke all on function public.get_ai_usage_by_provider(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_ai_usage_by_provider(uuid, timestamptz, timestamptz) to service_role;

-- Recent-requests drill-down (Part 41) -- bounded limit, never unbounded.
create or replace function public.get_ai_usage_recent(
  p_organization_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_limit integer default 50
)
returns table (
  out_event_id uuid,
  out_created_at timestamptz,
  out_task_key text,
  out_provider text,
  out_model text,
  out_status text,
  out_cost_usd numeric,
  out_cost_known boolean,
  out_source_type text,
  out_source_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select id, created_at, task_key, provider, model, status, estimated_cost_usd, estimated_cost_usd is not null, source_type, source_id
    from public.ai_usage_events
   where organization_id = p_organization_id
     and created_at >= p_period_start
     and created_at < p_period_end
   order by created_at desc
   limit least(greatest(p_limit, 1), 200);
$$;

revoke all on function public.get_ai_usage_recent(uuid, timestamptz, timestamptz, integer) from public;
grant execute on function public.get_ai_usage_recent(uuid, timestamptz, timestamptz, integer) to service_role;
