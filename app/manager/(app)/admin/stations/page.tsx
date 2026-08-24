import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminStations } from "@/app/lib/admin/stations";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { AdminStationsView } from "./_components/AdminStationsView";
import { AddStationButton } from "./_components/AddStationButton";

/**
 * Admin -> Stations hub (Admin Foundation milestone, Part 20) -- a child
 * of the Admin sidebar group. Server-enforces requireAdmin() itself
 * (Part 5).
 */
export const dynamic = "force-dynamic";

export default async function AdminStationsPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const stations = await listAdminStations(getServiceRoleClient(), { organizationId: auth.manager.organizationId });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Stations" description="Manage operational destinations used by inventory withdrawals." action={<AddStationButton />} />
      <AdminStationsView initialStations={stations} />
    </div>
  );
}
