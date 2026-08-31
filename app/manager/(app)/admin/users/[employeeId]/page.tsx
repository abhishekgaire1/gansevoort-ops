import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getAdminUser, getEmployeeAuthUserId, getEmployeeStationAssignments } from "@/app/lib/admin/users";
import { getAuthAccountInfo } from "@/app/lib/admin/authAccounts";
import { listAllActiveStationsForOrganization } from "@/app/lib/kiosk/stations";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { AdminUserDetailView } from "./_components/AdminUserDetailView";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const { employeeId } = await params;
  const supabase = getServiceRoleClient();
  const [user, stations, assignments] = await Promise.all([
    getAdminUser(supabase, auth.manager.organizationId, employeeId),
    listAllActiveStationsForOrganization(supabase, auth.manager.organizationId),
    getEmployeeStationAssignments(supabase, auth.manager.organizationId, employeeId),
  ]);

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/admin/users" className={textLinkClass}>
          ← Users
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">User not found.</p>
        </div>
      </div>
    );
  }

  const isSelf = user.appUserId === auth.manager.appUserId;

  const authUserId = user.hasAuthAccount ? await getEmployeeAuthUserId(supabase, auth.manager.organizationId, employeeId) : null;
  const authAccount = authUserId ? await getAuthAccountInfo(supabase, authUserId) : null;

  return (
    <div className="mx-auto max-w-2xl">
      <AdminUserDetailView user={user} stations={stations} assignedStationIds={assignments.map((a) => a.stationId)} isSelf={isSelf} authAccount={authAccount} />
    </div>
  );
}
