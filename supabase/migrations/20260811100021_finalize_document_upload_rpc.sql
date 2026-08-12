-- Milestone 2A.1: transactional document + first extraction attempt finalize
--
-- Two separate PostgREST insert calls from application code are NOT
-- atomic: a failure between them could leave a documents row with zero
-- document_extractions rows, and neither call is safe to blindly retry (a
-- retried documents insert with the same id would fail with a plain
-- unique_violation that looks identical to a genuine integrity problem).
-- This RPC performs both inserts inside ONE function invocation -- a
-- single top-level statement is implicitly one Postgres transaction, so
-- either both rows exist afterward or neither does.
--
-- Idempotent replay: if a document with this exact id already exists, its
-- immutable identity fields (organization_id, storage_path, file_sha256,
-- byte_size, content_type) must match the finalize request byte-for-byte,
-- or the call fails closed with the app-defined 'GA001' conflict SQLSTATE
-- -- it never overwrites or deletes the existing row. A matching replay
-- heals a missing initial extraction attempt if one doesn't already exist
-- (e.g. a prior call's own extraction insert failed before this RPC
-- existed), but never touches an attempt that's already there.
--
-- Concurrent double-submission (not just sequential retries) is handled
-- the same way record_inventory_withdrawal handles it
-- (20260811100015_withdrawal_idempotency.sql): the speculative insert is
-- wrapped in `exception when unique_violation`, so if two truly
-- simultaneous calls race for the same new document_id, the loser falls
-- through to the identical compare-and-heal logic the "already exists"
-- branch uses, rather than erroring.

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
      insert into public.documents (
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
  select id into v_attempt_id
    from public.document_extractions
   where document_id = p_document_id
     and attempt_number = 1;

  if not found then
    begin
      insert into public.document_extractions (
        organization_id, document_id, attempt_number, provider, model, status
      ) values (
        p_organization_id, p_document_id, 1, p_provider, p_model, 'PENDING'
      ) returning id into v_attempt_id;
    exception when unique_violation then
      -- A concurrent replay/heal call won the race to create attempt 1.
      select id into v_attempt_id
        from public.document_extractions
       where document_id = p_document_id
         and attempt_number = 1;

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
