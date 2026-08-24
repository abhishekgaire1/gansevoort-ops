import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminVendors } from "@/app/lib/admin/vendors";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { AdminVendorsView } from "./_components/AdminVendorsView";
import { AddVendorButton } from "./_components/AddVendorButton";

/**
 * Admin -> Vendors (Admin Master Data milestone) -- a child of the Admin
 * sidebar group. General Vendor administration is Admin-only (Part 15/41):
 * this route server-enforces requireAdmin() itself, so a Manager hitting
 * it directly is redirected, never merely hidden from the sidebar. The
 * ONE controlled exception -- a Manager creating a Vendor from inside
 * Receiving when no match exists -- lives entirely on the Receiving
 * surface (UploadDocumentForm / Step1ReviewInvoice), never here.
 */
export const dynamic = "force-dynamic";

export default async function AdminVendorsPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const vendors = await listAdminVendors(getServiceRoleClient(), { organizationId: auth.manager.organizationId });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Vendors"
        description="Manage approved vendors used across Receiving. Deactivating a vendor hides it from new invoice uploads without affecting documents that already reference it."
        action={<AddVendorButton />}
      />
      <AdminVendorsView initialVendors={vendors} />
    </div>
  );
}
