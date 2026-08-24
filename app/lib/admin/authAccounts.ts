import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Identity + Access Management milestone -- resolves the Supabase Auth
 * facts (email, invited/active status) for an app_user's auth_user_id.
 * Deliberately separate from getAdminUser/listAdminUsers: email/
 * confirmation status live in auth.users, not in this schema's own
 * tables, and fetching them requires the Auth Admin API (server-only,
 * Part 23/48) rather than a plain table read. Only called for the ONE
 * user being viewed on a detail page -- never in the list, to avoid an
 * N+1 Admin API call per row (Part 25's own "do not fabricate last-login/
 * invitation state" also means: only show what's genuinely available,
 * fetched only where actually displayed).
 */

export interface AuthAccountInfo {
  authUserId: string;
  email: string | null;
  /** "invited" when Supabase has not yet recorded email confirmation
   * (the person has not completed their invite/reset link); "active"
   * once they have. Never fabricated -- absent entirely if the auth user
   * can't be resolved at all. */
  status: "active" | "invited";
  invitedAt: string | null;
}

export async function getAuthAccountInfo(supabase: SupabaseClient, authUserId: string): Promise<AuthAccountInfo | null> {
  const { data, error } = await supabase.auth.admin.getUserById(authUserId);
  if (error || !data?.user) return null;

  const confirmed = Boolean(data.user.email_confirmed_at ?? data.user.confirmed_at);
  return {
    authUserId,
    email: data.user.email ?? null,
    status: confirmed ? "active" : "invited",
    invitedAt: data.user.invited_at ?? null,
  };
}
