import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminUsers } from "@/app/lib/admin/users";
import { listActiveStationsForOrganization } from "@/app/lib/kiosk/stations";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { AdminUsersView } from "./_components/AdminUsersView";
import { AddUserButton } from "./_components/AddUserButton";
import { KioskPinLockoutPanel } from "./_components/KioskPinLockoutPanel";

/**
 * Admin -> Users hub (Admin Foundation milestone, Part 7) -- a child of
 * the Admin sidebar group, never a top-level route. Server-enforces
 * requireAdmin() itself (Part 5) rather than trusting the sidebar being
 * hidden from non-admins.
 */
export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const supabase = getServiceRoleClient();
  const [users, stations] = await Promise.all([
    listAdminUsers(supabase, { organizationId: auth.manager.organizationId }),
    listActiveStationsForOrganization(supabase, auth.manager.organizationId),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Users" description="Manage employees and application access." action={<AddUserButton stations={stations} />} />
      <KioskPinLockoutPanel />
      <AdminUsersView initialUsers={users} stations={stations} />
    </div>
  );
}
