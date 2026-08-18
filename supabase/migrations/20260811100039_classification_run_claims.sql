-- Milestone 2A.3 (part 5 of 8): purchase_document_classification_runs +
-- its atomic claim/finish RPCs.
--
-- Classification can be started from four independent places (auto after()
-- on submit, auto after() on review-correction/atomic-verify, automatic
-- recovery on page load, and the manual "Run Item Matching" button). This
-- table + its two RPCs guarantee at most one of them is ever actually
-- doing AI-classification work for a given purchase document at a time.
--
-- Deliberately NOT append-only, and forbid_update_delete() must never be
-- applied to it: this is controlled, mutable execution-coordination
-- state, not a historical business fact. Every genuine business result
-- (which item a line resolved to, who approved what, when) lives in
-- purchase_document_line_classifications/audit_events, which remain the
-- durable record -- this table only ever answers "is a run currently
-- active for this document, and if not, when did the last one finish and
-- how."
create table public.purchase_document_classification_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome text,
  constraint purchase_document_classification_runs_pd_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id),
  constraint purchase_document_classification_runs_outcome_check
    check (outcome is null or outcome in ('SUCCEEDED', 'FAILED', 'ABANDONED'))
);

-- At most one ACTIVE (unfinished) claim per purchase document, at any
-- time, from any trigger source. This is the concurrency guard; the RPCs
-- below are what make it safe to rely on under real concurrent access.
create unique index purchase_document_classification_runs_active_key
  on public.purchase_document_classification_runs (organization_id, purchase_document_id)
  where completed_at is null;

create index purchase_document_classification_runs_pd_idx
  on public.purchase_document_classification_runs (purchase_document_id, started_at desc);

alter table public.purchase_document_classification_runs enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- try_claim_purchase_document_classification_run
-- ============================================================
-- Single atomic transaction. SELECT ... FOR UPDATE alone does NOT fully
-- serialize this: it only blocks a second caller when an active row
-- already exists to lock. Two real gaps remain without a further guard:
-- (a) when there is no active row at all (the very first claim for a
-- document, or immediately after this same transaction abandons the old
-- one), two concurrent callers can both see "no row found" and both race
-- straight to INSERT; (b) during stale-claim reclamation specifically,
-- once the winning caller commits its abandon-then-insert, a second
-- caller that was blocked on the OLD row's lock unblocks, correctly sees
-- no active old row -- but then also proceeds straight to INSERT,
-- colliding with the WINNER'S BRAND-NEW claim rather than the old one.
--
-- Fix: the partial unique index is the explicit, mandatory final backstop,
-- handled INSIDE this function, never left to propagate as a raw error.
-- The INSERT is wrapped in its own exception block: a unique_violation
-- (SQLSTATE 23505) is caught here and mapped to a clean ALREADY_RUNNING
-- result -- never retried, never used as a reason to abandon/replace
-- whatever claim now exists (it is, by definition, not stale -- it was
-- just created), and never allowed to propagate to the caller as a raw
-- constraint-violation error. This guarantees the only two possible
-- outcomes for any two callers racing at any point in this function --
-- on a document with no prior claim, or both reclaiming the same stale
-- one -- are EXACTLY one CLAIMED and exactly one ALREADY_RUNNING, never
-- two CLAIMEDs and never an unhandled error surfacing to either caller.
create or replace function public.try_claim_purchase_document_classification_run(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_stale_after_seconds integer default 300
)
returns table (
  out_claim_id uuid,
  out_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_id uuid;
  v_existing_started_at timestamptz;
  v_new_id uuid;
begin
  select r.id, r.started_at
    into v_existing_id, v_existing_started_at
    from public.purchase_document_classification_runs r
   where r.organization_id = p_organization_id
     and r.purchase_document_id = p_purchase_document_id
     and r.completed_at is null
   for update;

  if found then
    if now() - v_existing_started_at < make_interval(secs => p_stale_after_seconds) then
      -- Genuinely in progress -- never "stolen" by a second caller.
      return query select null::uuid, 'ALREADY_RUNNING'::text;
      return;
    end if;

    -- Stale: atomically transition it out of the way, in THIS same
    -- transaction, before attempting anything else. This is the step a
    -- purely conceptual "consider it abandoned" check would miss --
    -- without this UPDATE, the partial unique index would still reject
    -- every future INSERT attempt forever.
    update public.purchase_document_classification_runs
       set completed_at = now(),
           outcome = 'ABANDONED'
     where id = v_existing_id;
  end if;

  v_new_id := gen_random_uuid();
  begin
    insert into public.purchase_document_classification_runs (id, organization_id, purchase_document_id)
    values (v_new_id, p_organization_id, p_purchase_document_id);
  exception when unique_violation then
    -- Another caller's INSERT (racing on a document with no prior claim,
    -- or racing to reclaim the same stale one) won first. Report cleanly,
    -- do not retry, do not touch the winner's fresh claim.
    return query select null::uuid, 'ALREADY_RUNNING'::text;
    return;
  end;

  return query select v_new_id, 'CLAIMED'::text;
end;
$$;

revoke all on function public.try_claim_purchase_document_classification_run(uuid, uuid, integer) from public;
grant execute on function public.try_claim_purchase_document_classification_run(uuid, uuid, integer) to service_role;

-- ============================================================
-- finish_purchase_document_classification_run
-- ============================================================
-- Normal completion goes through this controlled, server-owned path
-- rather than only a client-side try/finally -- idempotent: a second call
-- against an already-completed claim is a silent no-op (the WHERE
-- completed_at is null guard), never an error. If the worker process dies
-- outright, this never runs at all -- which is exactly why stale-claim
-- reclamation above is designed to work entirely independently of whether
-- this function is ever called.
create or replace function public.finish_purchase_document_classification_run(
  p_claim_id uuid,
  p_organization_id uuid,
  p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_outcome not in ('SUCCEEDED', 'FAILED') then
    raise exception 'invalid classification run outcome %', p_outcome;
  end if;

  update public.purchase_document_classification_runs
     set completed_at = now(),
         outcome = p_outcome
   where id = p_claim_id
     and organization_id = p_organization_id
     and completed_at is null;
end;
$$;

revoke all on function public.finish_purchase_document_classification_run(uuid, uuid, text) from public;
grant execute on function public.finish_purchase_document_classification_run(uuid, uuid, text) to service_role;
