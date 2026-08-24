import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveEmployeeDisplayNames } from "@/app/lib/inventory/cycleCounts";
import { ManagerShell } from "@/app/components/manager/ManagerShell";

/**
 * The auth guard for every real manager route (this route group -- app/manager/(app)/
 * -- doesn't affect URLs: app/manager/(app)/receiving resolves to /manager/receiving).
 * requireManagerOrAdmin() is reused completely unchanged from Milestone 2A.0;
 * this is the one place its result is turned into a redirect.
 *
 * Sidebar-First Manager Navigation milestone: the shell (sidebar + top
 * header + notifications + account area) is implemented ONCE here via
 * ManagerShell, a client component (active-route highlighting needs
 * usePathname()) -- every manager page automatically inherits it without
 * any per-page change.
 */
export default async function ManagerAppLayout({ children }: { children: ReactNode }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect("/manager/login");
  }

  const names = await resolveEmployeeDisplayNames(getServiceRoleClient(), [auth.manager.appUserId]);
  const managerName = names.get(auth.manager.appUserId) ?? "";

  // Admin Foundation milestone: sidebar visibility is derived from the
  // SAME role array requireManagerOrAdmin() already resolved above --
  // no extra query, and never client-trusted (Part 30).
  const isAdmin = auth.manager.roles.includes("admin");

  return (
    <ManagerShell managerName={managerName} isAdmin={isAdmin}>
      {children}
    </ManagerShell>
  );
}
