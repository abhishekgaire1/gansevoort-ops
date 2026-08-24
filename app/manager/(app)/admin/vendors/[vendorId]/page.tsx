import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getAdminVendorAction } from "@/app/actions/adminVendors";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { AdminVendorDetailView } from "./_components/AdminVendorDetailView";

export const dynamic = "force-dynamic";

export default async function AdminVendorDetailPage({ params }: { params: Promise<{ vendorId: string }> }) {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const { vendorId } = await params;
  const result = await getAdminVendorAction(vendorId);

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/admin/vendors" className={textLinkClass}>
          ← Vendors
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">{result.reason === "not_found" ? "Vendor not found." : "You must be signed in as an Admin."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <AdminVendorDetailView vendor={result.vendor} aliases={result.aliases} mappings={result.mappings} />
    </div>
  );
}
