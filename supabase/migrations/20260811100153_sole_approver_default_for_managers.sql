-- Single-manager invoice posting is now the DEFAULT for every manager.
--
-- Supersedes the per-user gate introduced in 20260811100133, which granted
-- purchase_documents.post_without_second_review only through the dedicated
-- "purchase_sole_approver" role, assigned per person by an Admin (its own
-- header said the permission is "never implied by holding the manager or
-- admin role itself"). Product decision (2026-09-17): every manager may
-- post a fully-validated invoice without an independent second reviewer,
-- after the explicit on-screen acknowledgment the SoleApproverPostModal
-- already requires. The maker-checker second review becomes OPTIONAL, not
-- mandatory. See docs/BUSINESS_RULES.md (Invoice Review) for the rule.
--
-- Mechanism: grant the existing permission to the base "manager" and
-- "admin" roles. public.has_permission() resolves through role_permissions,
-- so this single grant makes every manager/admin eligible in BOTH the UI
-- gate (canUseSoleApproverPosting) and the authoritative RPC
-- (post_purchase_document_sole_approver) at once, with no change to any
-- enforcement code -- the RPC's own GA076 permission check still runs and
-- now simply passes for managers. Nothing else about the posting path
-- (completeness gates, duplicate/total checks, amendment re-post guard,
-- optimistic-concurrency lock, structured audit event) is relaxed.
--
-- The dedicated "purchase_sole_approver" role remains valid and additive --
-- it can still confer the capability on a future non-manager identity --
-- but is no longer required for a manager to post.

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r, public.permissions p
 where r.name in ('manager', 'admin')
   and p.key = 'purchase_documents.post_without_second_review'
on conflict (role_id, permission_id) do nothing;
