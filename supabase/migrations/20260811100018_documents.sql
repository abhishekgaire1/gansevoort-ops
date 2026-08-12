-- Milestone 2A.1: documents
--
-- The permanent record of an original uploaded invoice/receipt/etc. file.
-- Fully append-only (reuses the same forbid_update_delete() guard as
-- inventory_movements/audit_events): documents represents immutable source-
-- document facts only, never a mutable AI-classification cache. In
-- particular there is deliberately no document_type column here -- the
-- AI's provisional classification of a document already lives in the
-- latest document_extractions.normalized_extraction row for it (added in
-- 20260811100020), and the queue/detail UI derives "Invoice (Extracted --
-- Unverified)"-style labels from that join rather than caching a
-- system-writable copy on this otherwise-immutable table.
--
-- storage_path is the stable, server-generated Supabase Storage object key
-- (org/<organization_id>/documents/<document_id>/original.<ext>) and never
-- encodes vendor/date/invoice-number, since those are extracted (and later
-- corrected) well after the file already has to exist at a fixed path. A
-- human-readable archive filename is derived on demand at signed-URL
-- generation time from verified data once it exists -- never stored here.

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  uploaded_by_app_user_id uuid not null,
  storage_path text not null,
  original_filename text not null,
  content_type text not null,
  byte_size bigint not null,
  file_sha256 text not null,
  created_at timestamptz not null default now(),
  -- the uploader must belong to the same organization as the document
  constraint documents_uploaded_by_org_fk foreign key (uploaded_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint documents_content_type_check check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  constraint documents_byte_size_check check (byte_size > 0),
  constraint documents_sha256_check check (char_length(file_sha256) = 64),
  -- composite-FK target for document_extractions below
  constraint documents_id_org_key unique (id, organization_id)
);

-- Storage paths are server-generated and unique per organization by
-- construction (each embeds a fresh document id), but the constraint keeps
-- that guarantee enforced at the database level, not just by application code.
create unique index documents_org_storage_path_key
  on public.documents (organization_id, storage_path);

-- Supports the duplicate-file-detection lookup at upload time. Deliberately
-- NOT unique: the same file may legitimately be uploaded more than once
-- (a manager may explicitly choose "Upload Anyway" after a duplicate warning).
create index documents_org_sha256_idx
  on public.documents (organization_id, file_sha256);

create index documents_org_created_at_idx
  on public.documents (organization_id, created_at desc);

create trigger documents_forbid_update
  before update on public.documents
  for each row execute function public.forbid_update_delete();

create trigger documents_forbid_delete
  before delete on public.documents
  for each row execute function public.forbid_update_delete();

alter table public.documents enable row level security;
-- Deny-by-default: no policies for anon/authenticated. All access flows
-- through service-role server code (upload finalize, signed-URL issuance,
-- the receiving queue/detail pages), gated by requireManagerOrAdmin().
