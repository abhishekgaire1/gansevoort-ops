-- Fix: ambiguous "document_id" column reference in finalize_document_upload
--
-- 20260811100021 has ALREADY been applied to the linked dev database, so
-- this is a bugfix migration (create or replace), not an edit to that file.
--
-- Root cause: `returns table (document_id uuid, attempt_id uuid, replayed
-- boolean)` implicitly declares document_id/attempt_id/replayed as OUT
-- parameters -- ordinary PL/pgSQL variables in scope for the entire
-- function body, for its whole lifetime. public.document_extractions also
-- has a real column literally named document_id. Two statements referenced
-- the bare identifier `document_id`, which is legal to write but is
-- genuinely ambiguous once both a same-named variable AND a same-named
-- column are simultaneously in scope for that query:
--
--   select id into v_attempt_id
--     from public.document_extractions
--    where document_id = p_document_id   -- ambiguous: OUT param or column?
--      and attempt_number = 1;
--
-- This statement runs unconditionally on every call (fresh insert, replay,
-- and healed-existing-document paths all reach it), so even a first-ever,
-- non-replay finalize call hit it -- exactly the real upload failure this
-- migration fixes. It was never caught by the unit tests because the
-- mocked Supabase client in tests/documentUploadAction.unit.test.ts and
-- tests/finalizeDocumentUploadRpc.unit.test.ts never sends a query to a
-- real Postgres parser; only an actual call reaches Postgres's name
-- resolution. See the new tests/finalizeDocumentUploadRpc.rpc.test.ts
-- (manual, `npm run test:integration`) added alongside this migration,
-- which invokes the real RPC and would have caught this.
--
-- Fix: alias every table referenced in the function body (documents d,
-- document_extractions de) and fully qualify every column reference
-- throughout the whole function -- not just the two statements that
-- failed -- so no future edit to this function can reintroduce the same
-- class of bug elsewhere in it. The function's name, parameter list, and
-- RETURNS TABLE shape are byte-for-byte unchanged from 20260811100021:
-- this is a pure `create or replace`, not a new overload, and the
-- TypeScript wrapper (app/lib/documents/finalizeDocumentUploadRpc.ts)
-- requires no change. Every other behavior from 20260811100021 -- atomic
-- documents+attempt-1 creation, idempotent replay, immutable-identity
-- comparison, the GA001 conflict code, healing a missing attempt 1,
-- concurrency safety via the unique_violation fallback, SECURITY DEFINER,
-- SET search_path = '', and service_role-only execution -- is preserved
-- exactly.

create or replace function public.finalize_document_upload(
  p_document_id uuid,
  p_organization_id uuid,
  p_uploaded_by_app_user_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_content_type text,
  p_byte_size bigint,
  p_file_sha256 text,
  p_provider text,
  p_model text
)
returns table (
  document_id uuid,
  attempt_id uuid,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_have_existing boolean;
  v_attempt_id uuid;
  v_replayed boolean;
begin
  select d.organization_id, d.storage_path, d.file_sha256, d.byte_size, d.content_type
    into v_existing
    from public.documents d
   where d.id = p_document_id;
  v_have_existing := found;

  if not v_have_existing then
    begin
      insert into public.documents as d (
        id, organization_id, uploaded_by_app_user_id, storage_path,
        original_filename, content_type, byte_size, file_sha256
      ) values (
        p_document_id, p_organization_id, p_uploaded_by_app_user_id, p_storage_path,
        p_original_filename, p_content_type, p_byte_size, p_file_sha256
      );
      v_replayed := false;
    exception when unique_violation then
      select d.organization_id, d.storage_path, d.file_sha256, d.byte_size, d.content_type
        into v_existing
        from public.documents d
       where d.id = p_document_id;

      if not found then
        raise exception 'document_id % conflicted on insert but no matching document was found on retry', p_document_id;
      end if;

      v_have_existing := true;
    end;
  end if;

  if v_have_existing then
    -- Reached either because the document already existed at the top, or
    -- because we just lost the insert race above -- both land here with
    -- v_existing populated and NO documents row inserted by this call.
    if v_existing.organization_id is distinct from p_organization_id
       or v_existing.storage_path is distinct from p_storage_path
       or v_existing.file_sha256 is distinct from p_file_sha256
       or v_existing.byte_size is distinct from p_byte_size
       or v_existing.content_type is distinct from p_content_type
    then
      -- App-defined SQLSTATE (not a reserved Postgres class): lets calling
      -- code distinguish "this documentId already refers to a DIFFERENT
      -- document" from an ordinary DB error, without string-matching the
      -- message. The existing row and its Storage object are left
      -- completely untouched -- this function performs no delete of any
      -- kind, and the caller must not either.
      raise exception 'document_id % already exists with different file identity', p_document_id
        using errcode = 'GA001';
    end if;

    v_replayed := true;
  end if;

  -- Ensure the initial attempt (attempt_number = 1) exists -- covers a
  -- fresh document, a matching replay, and a healed pre-existing document
  -- that never got its first attempt. Exactly one path, used in every case.
  -- `de.document_id` is fully qualified: document_extractions has a real
  -- document_id column, and this function's own RETURNS TABLE also
  -- declares an OUT parameter named document_id -- the bug this migration
  -- fixes was leaving this bare.
  select de.id into v_attempt_id
    from public.document_extractions de
   where de.document_id = p_document_id
     and de.attempt_number = 1;

  if not found then
    begin
      insert into public.document_extractions as de (
        organization_id, document_id, attempt_number, provider, model, status
      ) values (
        p_organization_id, p_document_id, 1, p_provider, p_model, 'PENDING'
      ) returning de.id into v_attempt_id;
    exception when unique_violation then
      -- A concurrent replay/heal call won the race to create attempt 1.
      select de.id into v_attempt_id
        from public.document_extractions de
       where de.document_id = p_document_id
         and de.attempt_number = 1;

      if not found then
        raise exception 'attempt 1 for document_id % conflicted on insert but no matching attempt was found on retry', p_document_id;
      end if;
    end;
  end if;

  return query select p_document_id, v_attempt_id, v_replayed;
end;
$$;

revoke all on function public.finalize_document_upload(
  uuid, uuid, uuid, text, text, text, bigint, text, text, text
) from public;

grant execute on function public.finalize_document_upload(
  uuid, uuid, uuid, text, text, text, bigint, text, text, text
) to service_role;
