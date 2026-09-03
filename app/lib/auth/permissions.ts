import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fine-grained permission checks layered on top of the existing
 * roles/user_roles/role_permissions RBAC schema (20260811100133 --
 * docs/DATABASE.md's "role_permissions" domain, created for the first
 * time by that migration). A manager/admin's own job-title role never
 * implies a specific permission by itself; a permission is granted to an
 * INDIVIDUAL app_user by an Admin (via a dedicated role, e.g.
 * "purchase_sole_approver", assigned only to that person).
 *
 * Mirrors public.has_permission(...) exactly -- this is a read-only
 * convenience for the app layer (e.g. deciding whether to show a button
 * at all); the actual non-bypassable enforcement is the SAME check
 * re-run inside every RPC that requires it, never trusted from here
 * alone.
 */
export async function userHasPermission(
  supabase: SupabaseClient,
  input: { appUserId: string; organizationId: string; permissionKey: string }
): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_permission", {
    p_app_user_id: input.appUserId,
    p_organization_id: input.organizationId,
    p_permission_key: input.permissionKey,
  });
  if (error) {
    throw new Error(`has_permission failed: ${error.message}`);
  }
  return Boolean(data);
}

export const SOLE_APPROVER_PERMISSION_KEY = "purchase_documents.post_without_second_review";
