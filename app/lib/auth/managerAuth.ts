import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";

/**
 * Resolves the manager/admin calling a manager-only server action, via
 * their Supabase Auth session (browser, not the shared kiosk). Only this
 * resolve/authorize helper is in scope this slice -- no login page.
 *
 * The auth-session client only proves *who* is asking (their auth.users id
 * -> app_users row). Looking up their app_user row and roles still goes
 * through the service-role client, matching the deny-by-default RLS
 * posture used everywhere else in this schema: an authenticated Supabase
 * Auth session grants no direct table access on its own.
 */

export interface AuthorizedManager {
  appUserId: string;
  organizationId: string;
  authUserId: string;
  roles: string[];
}

export type ManagerAuthResult =
  | { ok: true; manager: AuthorizedManager }
  | { ok: false; reason: "not_authenticated" | "not_authorized" };

const AUTHORIZED_ROLE_NAMES = ["manager", "admin"];

export async function requireManagerOrAdmin(): Promise<ManagerAuthResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  const cookieStore = await cookies();
  const supabaseAuthClient = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      // Read-only usage: this helper only resolves the caller's identity,
      // it never needs to refresh/write auth cookies itself.
      setAll: () => {},
    },
  });

  const {
    data: { user },
  } = await supabaseAuthClient.auth.getUser();

  if (!user) {
    return { ok: false, reason: "not_authenticated" };
  }

  const serviceClient = getServiceRoleClient();

  const { data: appUser, error: appUserError } = await serviceClient
    .from("app_users")
    .select("id, organization_id")
    .eq("auth_user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (appUserError) {
    throw new Error(`failed to resolve app_user for auth session: ${appUserError.message}`);
  }
  if (!appUser) {
    return { ok: false, reason: "not_authorized" };
  }

  const { data: roleRows, error: roleError } = await serviceClient
    .from("user_roles")
    .select("roles(name)")
    .eq("app_user_id", appUser.id);

  if (roleError) {
    throw new Error(`failed to resolve roles for app_user ${appUser.id}: ${roleError.message}`);
  }

  const roles = (roleRows ?? [])
    .map((row) => (row as unknown as { roles: { name: string } | null }).roles?.name)
    .filter((name): name is string => Boolean(name));

  if (!roles.some((role) => AUTHORIZED_ROLE_NAMES.includes(role))) {
    return { ok: false, reason: "not_authorized" };
  }

  return {
    ok: true,
    manager: {
      appUserId: appUser.id,
      organizationId: appUser.organization_id,
      authUserId: user.id,
      roles,
    },
  };
}
