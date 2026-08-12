-- Milestone 2A.1: document_extractions
--
-- One durable row per AI extraction attempt against a document. Retries
-- insert a NEW row (attempt_number + 1); an attempt is never overwritten
-- with a different attempt's result. Lifecycle: PENDING -> RUNNING ->
-- SUCCEEDED | FAILED. Once an attempt reaches a terminal status it is
-- guarded from further modification by the transition trigger below --
-- this is the historical record of what the AI actually returned, the same
-- integrity category as audit_events, but attempts genuinely transition in
-- place while non-terminal, so the plain forbid_update_delete() guard
-- (which forbids ALL updates unconditionally) doesn't fit here the way it
-- does for documents/audit_events/inventory_movements.

create table public.document_extractions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  document_id uuid not null,
  attempt_number integer not null,
  provider text not null,
  model text not null,
  status text not null default 'PENDING',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  normalized_extraction jsonb,
  review_flags jsonb not null default '[]'::jsonb,
  provider_metadata jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  constraint document_extractions_attempt_number_check check (attempt_number > 0),
  constraint document_extractions_status_check check (status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  constraint document_extractions_error_message_len_check check (error_message is null or char_length(error_message) <= 2000),
  -- an attempt's document must belong to the same organization as the attempt
  constraint document_extractions_doc_org_fk foreign key (document_id, organization_id)
    references public.documents (id, organization_id)
);

-- Attempt numbers are per-document sequence, assigned by application code
-- (max(attempt_number) + 1), enforced unique here rather than trusted.
create unique index document_extractions_doc_attempt_key
  on public.document_extractions (document_id, attempt_number);

-- DB-level guarantee (not just UI disable-on-click / app pre-checks): a
-- document can have at most one attempt that is still PENDING or RUNNING
-- at a time. Combined with the conditional "update ... where status =
-- 'PENDING'" claim the executor uses, this makes "one active attempt per
-- document" and "exactly one executor per attempt" both hold structurally.
create unique index document_extractions_one_active_per_document
  on public.document_extractions (document_id)
  where status in ('PENDING', 'RUNNING');

create index document_extractions_org_created_at_idx
  on public.document_extractions (organization_id, created_at desc);

-- Once terminal (SUCCEEDED/FAILED), an attempt may never be modified again.
-- While non-terminal, identity/config columns (who/what/when this attempt
-- is) may never change, and status may only move forward
-- (PENDING -> RUNNING|FAILED, RUNNING -> SUCCEEDED|FAILED) -- never back to
-- PENDING. A stale PENDING attempt (e.g. its after() invocation never ran)
-- is terminalized straight to FAILED without passing through RUNNING.
create or replace function public.document_extractions_guard_transitions()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('SUCCEEDED', 'FAILED') then
    raise exception 'document_extractions attempt % is terminal (%) and cannot be modified', old.id, old.status;
  end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.document_id is distinct from old.document_id
     or new.attempt_number is distinct from old.attempt_number
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.requested_at is distinct from old.requested_at
     or new.created_at is distinct from old.created_at
  then
    raise exception 'document_extractions attempt % may not change its identity/config columns', old.id;
  end if;

  if old.status = 'PENDING' and new.status not in ('PENDING', 'RUNNING', 'FAILED') then
    raise exception 'document_extractions attempt % may not transition from PENDING to %', old.id, new.status;
  end if;

  if old.status = 'RUNNING' and new.status not in ('RUNNING', 'SUCCEEDED', 'FAILED') then
    raise exception 'document_extractions attempt % may not transition from RUNNING to %', old.id, new.status;
  end if;

  return new;
end;
$$;

create trigger document_extractions_guard_transitions
  before update on public.document_extractions
  for each row execute function public.document_extractions_guard_transitions();

create trigger document_extractions_forbid_delete
  before delete on public.document_extractions
  for each row execute function public.forbid_update_delete();

alter table public.document_extractions enable row level security;
-- Deny-by-default: no policies for anon/authenticated.
