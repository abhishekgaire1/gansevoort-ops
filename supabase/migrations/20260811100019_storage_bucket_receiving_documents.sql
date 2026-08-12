-- Milestone 2A.1: private Storage bucket for receiving documents
--
-- Private (public = false): every read goes through a short-lived signed
-- URL minted server-side after requireManagerOrAdmin() + organization
-- ownership checks -- never a permanent/public object URL. file_size_limit
-- and allowed_mime_types are enforced here as a bucket-level backstop, in
-- addition to the application-level checks at upload initiate/finalize.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receiving-documents',
  'receiving-documents',
  false,
  20971520, -- 20 MiB, matching the application-level MAX_FILE_BYTES limit
  array['application/pdf', 'image/jpeg', 'image/png']
);

-- Deny-by-default, matching every table in this schema: no storage.objects
-- RLS policies are created here. All object reads/writes for this bucket go
-- through the service-role client in trusted server code (signed upload
-- URLs minted at initiate, signed view/download URLs minted on request),
-- never a direct browser connection to Storage.
