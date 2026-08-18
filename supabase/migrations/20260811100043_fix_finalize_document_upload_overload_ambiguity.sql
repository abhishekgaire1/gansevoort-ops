-- Fixes a real bug in 20260811100038: CREATE OR REPLACE FUNCTION does NOT
-- replace a function whose parameter list differs, even when the new
-- parameters are only added at the end with defaults -- it creates a
-- SECOND, overloaded function instead. 100038 added
-- p_declared_disposition_hint/p_delivery_verified_by_employee_id this way,
-- which left the ORIGINAL 12-parameter finalize_document_upload (from
-- 20260811100024) sitting alongside the new 14-parameter one. Every real
-- caller -- app/lib/documents/finalizeDocumentUploadRpc.ts, used by every
-- document upload in the app -- calls with exactly the original 12 named
-- parameters, which Postgres can now equally satisfy by either (a) the
-- 12-param function directly, or (b) the 14-param function with its 2 new
-- parameters defaulted, and refuses to pick one: "Could not choose the
-- best candidate function." This was caught by actually applying these
-- migrations to DEV and exercising a real upload path via the .rpc.test.ts
-- suite -- exactly the class of bug supabase db push --dry-run cannot
-- catch, since it only lists pending files, it does not execute them.
--
-- 100038 is already applied and, per policy, is never edited after the
-- fact -- this is a new, additive migration that drops the now-superseded
-- 12-param overload, leaving only the 14-param one from 100038 (which
-- already has correct defaults, so every existing 12-argument caller keeps
-- working unchanged; it was ONLY the leftover old overload causing the
-- ambiguity, not the new function's own shape).
drop function if exists public.finalize_document_upload(
  uuid, uuid, uuid, text, text, text, bigint, text, text, text, uuid, text
);
