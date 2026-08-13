-- Milestone 2A.2: vendor-first + document-type-first upload
--
-- Two new immutable, human-declared facts added to the already-applied
-- 2A.1 `documents` table: vendor_id and declared_document_type. Both are
-- fixed by the manager at the moment of upload -- structurally the same
-- kind of fact as the pre-existing uploaded_by_app_user_id (fixed by a
-- human at creation time, never AI-derived, never later-corrected on this
-- table), which is exactly why they belong here rather than being
-- deferred to the correctable purchase_documents layer added in
-- 20260811100025. Both nullable at the DB level: existing 2A.1 rows
-- predate this rule and get neither retroactively fabricated nor
-- backfilled ("do not overwrite historical data"). Every NEW upload is
-- required to supply both -- enforced below by finalize_document_upload
-- itself, not a NOT NULL constraint.

alter table public.documents
  add column vendor_id uuid,
  add column declared_document_type text;

alter table public.documents
  add constraint documents_vendor_org_fk foreign key (vendor_id, organization_id)
    references public.vendors (id, organization_id);

alter table public.documents
  add constraint documents_declared_document_type_check
    check (declared_document_type is null or declared_document_type in ('INVOICE', 'RECEIPT', 'CREDIT_MEMO'));

create index documents_org_vendor_idx
  on public.documents (organization_id, vendor_id);

-- finalize_document_upload's signature changes ONCE (both new parameters
-- together), matching the drop-and-recreate precedent from
-- 20260811100015_withdrawal_idempotency.sql: adding a parameter via
-- `create or replace function` would create a confusingly ambiguous
-- overload rather than truly replacing the existing 10-argument function,
-- so it is dropped first.
--
-- Idempotent-replay identity now includes both new fields: a document with
-- this exact id already exists is a safe replay ONLY if organization_id,
-- storage_path, file_sha256, byte_size, content_type, vendor_id, AND
-- declared_document_type all match -- a second finalize call for the same
-- documentId with a different declared vendor or type is exactly as much
-- a genuine identity conflict (GA001) as a different file hash already
-- was, and is handled identically: nothing is inserted, updated, or
-- deleted, the existing row and its Storage object are left untouched.
drop function if exists public.finalize_document_upload(
  uuid, uuid, uuid, text, text, text, bigint, text, text, text
);

create function public.finalize_document_upload(
  p_document_id uuid,
  p_organization_id uuid,
  p_uploaded_by_app_user_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_content_type text,
  p_byte_size bigint,
  p_file_sha256 text,
  p_provider text,
  p_model text,
  p_vendor_id uuid,
  p_declared_document_type text
)
returns table (
  out_document_id uuid,
  out_attempt_id uuid,
  out_replayed boolean
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
  select d.organization_id, d.storage_path, d.file_sha256, d.byte_size, d.content_type,
         d.vendor_id, d.declared_document_type
    into v_existing
    from public.documents d
   where d.id = p_document_id;
  v_have_existing := found;

  if not v_have_existing then
    -- Required-for-new-uploads validation lives here, not as a table-level
    -- NOT NULL, so legacy pre-2A.2 rows (which have neither) stay valid.
    if p_declared_document_type is null then
      raise exception 'declared_document_type is required for a new document upload';
    end if;

    if not exists (
      select 1 from public.vendors v
       where v.id = p_vendor_id
         and v.organization_id = p_organization_id
         and v.is_active
    ) then
      raise exception 'vendor_id % is not an active vendor in organization %', p_vendor_id, p_organization_id
        using errcode = 'GA005';
    end if;

    begin
      insert into public.documents as d (
        id, organization_id, uploaded_by_app_user_id, storage_path,
        original_filename, content_type, byte_size, file_sha256,
        vendor_id, declared_document_type
      ) values (
        p_document_id, p_organization_id, p_uploaded_by_app_user_id, p_storage_path,
        p_original_filename, p_content_type, p_byte_size, p_file_sha256,
        p_vendor_id, p_declared_document_type
      );
      v_replayed := false;
    exception when unique_violation then
      select d.organization_id, d.storage_path, d.file_sha256, d.byte_size, d.content_type,
             d.vendor_id, d.declared_document_type
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
    -- Note: an active-vendor re-check is deliberately NOT performed here --
    -- a REPLAY of an already-existing document must not be broken by a
    -- vendor being deactivated after the original successful finalize.
    if v_existing.organization_id is distinct from p_organization_id
       or v_existing.storage_path is distinct from p_storage_path
       or v_existing.file_sha256 is distinct from p_file_sha256
       or v_existing.byte_size is distinct from p_byte_size
       or v_existing.content_type is distinct from p_content_type
       or v_existing.vendor_id is distinct from p_vendor_id
       or v_existing.declared_document_type is distinct from p_declared_document_type
    then
      raise exception 'document_id % already exists with different file identity', p_document_id
        using errcode = 'GA001';
    end if;

    v_replayed := true;
  end if;

  -- Ensure the initial attempt (attempt_number = 1) exists -- covers a
  -- fresh document, a matching replay, and a healed pre-existing document
  -- that never got its first attempt. Exactly one path, used in every case.
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
      select de.id into v_attempt_id
        from public.document_extractions de
       where de.document_id = p_document_id
         and de.attempt_number = 1;

      if not found then
        raise exception 'attempt 1 for document_id % conflicted on insert but no matching attempt was found on retry', p_document_id;
      end if;
    end;
  end if;

  return query select p_document_id as out_document_id, v_attempt_id as out_attempt_id, v_replayed as out_replayed;
end;
$$;

revoke all on function public.finalize_document_upload(
  uuid, uuid, uuid, text, text, text, bigint, text, text, text, uuid, text
) from public;

grant execute on function public.finalize_document_upload(
  uuid, uuid, uuid, text, text, text, bigint, text, text, text, uuid, text
) to service_role;
