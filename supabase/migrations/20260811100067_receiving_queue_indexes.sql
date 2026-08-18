-- Milestone 2A.4 follow-up: operational indexes for the Receiving Queue's
-- hot path, addressing both a real defect surfaced under load and the
-- 2A.3 adversarial review's "indexes needed for obvious operational
-- paths" finding.
--
-- search_receiving_queue (20260811100028) computes its merged view over
-- EVERY document in the organization on every call:
--   1. latest_attempt: DISTINCT ON (document_id) ... ORDER BY document_id,
--      attempt_number DESC over document_extractions filtered by
--      organization_id -- with no covering index this is a full sort of
--      the org's entire extraction history per call.
--   2. LEFT JOIN purchase_documents ON source_document_id -- no index on
--      that join key existed at all (only the partial first-revision
--      unique).
-- Under concurrent load (the integration suite; eventually a real, busy
-- organization -- ~200 documents/week per docs/PRODUCT.md) the call
-- exceeded the statement timeout, and the then-silent error path made the
-- whole queue read as EMPTY (fixed to fail loudly in
-- app/lib/documents/receivingQueue.ts alongside this migration).
create index document_extractions_org_document_attempt_idx
  on public.document_extractions (organization_id, document_id, attempt_number desc);

create index purchase_documents_source_document_org_idx
  on public.purchase_documents (source_document_id, organization_id);
