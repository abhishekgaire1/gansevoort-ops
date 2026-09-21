import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminLocations } from "@/app/lib/admin/locations";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { AdminLocationsView } from "./_components/AdminLocationsView";
import { AddLocationButton } from "./_components/AddLocationButton";

/**
 * Admin -> Storage Locations. The single admin surface for public.locations
 * (the same dimension used by stations, inventory movements, and receiving).
 * Server-enforces requireAdmin() itself; locations are never hard-deleted
 * (deactivate only), and the server blocks deactivating/de-eligibility of a
 * location that holds stock or is the org default.
 */
export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const locations = await listAdminLocations(getServiceRoleClient(), auth.manager.organizationId);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Storage Locations"
        description="Where inventory is stored and received. Receiving can only use active, storage-eligible locations."
        action={<AddLocationButton />}
      />
      <AdminLocationsView initialLocations={locations} />
    </div>
  );
}
