import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { listVendors } from "@/app/actions/vendors";
import { VendorsManager } from "./_components/VendorsManager";

/**
 * The authoritative vendor master -- list/search/add/activate/deactivate.
 * No vendor-item mappings yet (deferred). Vendor selection is now required
 * BEFORE a document can be uploaded (see /manager/receiving's upload
 * form), so this list has to be populated before intake can happen at all.
 */
export const dynamic = "force-dynamic";

export default async function VendorsPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const result = await listVendors(true);
  const vendors = result.ok ? result.vendors : [];

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Vendors</h1>
      <p className="mt-1 text-sm text-zinc-400">
        The vendor a manager must select before uploading a purchasing document. Deactivating a vendor hides it from new
        uploads without affecting existing documents that already reference it.
      </p>
      <VendorsManager initialVendors={vendors} />
    </div>
  );
}
